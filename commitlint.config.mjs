export default {
  extends: ["@commitlint/config-conventional"],
  // PR merge commits are titled "Merge: <description> (#N)"; the PR's real
  // commits are linted by the PR-range CI step, so the merge subject is exempt.
  ignores: [(message) => /^Merge: /.test(message)],
  rules: {
    // subjects legitimately contain proper nouns (Agrippa, 硅基工坊, Drizzle…)
    "subject-case": [0],
  },
};
