# infra/janus — how the CI user reaches root

[Janus](https://github.com/hutusi/janus) runs `.janus/deploy.yml` on the Agrippa host
when the `deploy` branch moves. The deploy has to run as root: `/opt/agrippa` is
root-owned on purpose, so that a pipeline cannot edit the script it is about to run
as root, and `docker compose up` as a janus-writable tree would let any pipeline
mount any host path.

**`sudo` cannot provide that here.** Janus's own systemd unit sets
`NoNewPrivileges=true`. That flag is inherited by every descendant and cannot be
dropped by a child, so setuid is a permanent no-op for pipeline steps — `sudo` fails
with *"the no new privileges flag is set, which prevents sudo from running as root"*
no matter how the sudoers rule is written. This is not a misconfiguration to fix in
sudoers; it is a property of the process tree.

`systemctl` asks pid 1 to do the work over D-Bus instead of escalating in-process,
so the flag does not apply. polkit does the authorization:

| File | Role |
|---|---|
| `agrippa-deploy@.service` | oneshot unit; instance name is the commit — `ExecStart=/opt/agrippa/infra/deploy.sh %i` |
| `50-agrippa-deploy.rules` | lets `janus` **start** (only) units matching `agrippa-deploy@<hex>.service` (only) |

## Install

```sh
sudo install -d -o root -g janus -m 0750 /var/log/agrippa-deploy
sudo install -m 0644 infra/janus/'agrippa-deploy@.service' /etc/systemd/system/
sudo install -m 0644 infra/janus/50-agrippa-deploy.rules  /etc/polkit-1/rules.d/
sudo systemctl daemon-reload
sudo systemctl restart polkit
```

The log directory is `root:janus 0750` because the unit writes the deploy log there
for the pipeline to read back. The journal would be the obvious place, but the janus
user cannot read it, and adding it to `systemd-journal` would expose every unit's
logs to every pipeline this host runs.

## Verify

Both halves are worth testing — that the grant works, and that it does not reach
further. Use `setpriv --no-new-privs` so the test inherits the same constraint a real
pipeline step does; without it you are testing a more privileged process than Janus.

```sh
J="sudo -u janus -H setpriv --no-new-privs"
B=0000000000000000000000000000000000000000     # valid shape, not a real commit

# grant: reaches deploy.sh, which then refuses the commit itself
$J systemctl start --wait agrippa-deploy@$B.service; echo "exit $?"   # 1
sudo -u janus cat /var/log/agrippa-deploy/$B.log                      # "cannot resolve ..."

# boundary: all three must say "Interactive authentication required"
$J systemctl start cron.service
$J systemctl stop  agrippa-deploy@$B.service
$J systemctl start agrippa-deploy@notahexsha.service
```

Check the messages, not `$?` — piping systemctl through `tail` reports the pipe's
status and will look like success.

## Why the instance name is constrained to hex

`deploy.sh` already refuses any commit not reachable from `gitcode/deploy`, which is
the real boundary. The `[0-9a-f]{7,40}` pattern in the polkit rule is defence in
depth: it stops the unit name being used to reach some other instance of some other
template, and keeps the grant legible as "one unit, one verb".
