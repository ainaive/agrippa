/**
 * createDb's URL validation.
 *
 * These need no Postgres: every case asserts on a throw that happens before any
 * connection is attempted, so they run everywhere the unit suite does.
 *
 * The case that matters is the `/` one. infra/env/.env.example recommended
 * `openssl rand -base64 24` for POSTGRES_PASSWORD in the same commit that made
 * the variable mandatory, and base64's alphabet includes `/` — roughly a 40%
 * chance that a freshly generated password produced a stack that could not boot,
 * failing with a parse error that named neither the password nor DATABASE_URL.
 */
import { describe, expect, it } from "bun:test";
import { createDb } from "./client";

describe("createDb", () => {
  it("rejects a password containing an unencoded /, and says why", () => {
    // `/` terminates the URL's authority component, so this does not merely
    // authenticate wrongly — the URL cannot be parsed at all.
    expect(() => createDb("postgres://agrippa:ab/cd@postgres:5432/agrippa")).toThrow(
      /percent-encoded/,
    );
    // the message has to name the actual variable an operator would go looking for
    expect(() => createDb("postgres://agrippa:ab/cd@postgres:5432/agrippa")).toThrow(
      /DATABASE_URL/,
    );
  });

  it("accepts a percent-encoded password and a plain one", () => {
    // Over-eager validation would be its own outage, so pin both directions.
    // These construct a client but never connect, so no database is required.
    expect(() => createDb("postgres://agrippa:ab%2Fcd@postgres:5432/agrippa")).not.toThrow();
    expect(() => createDb("postgres://agrippa:plainpassword@postgres:5432/agrippa")).not.toThrow();
    // and what .env.example now recommends: 48 hex chars, URL-safe by construction
    const hex = "a".repeat(48);
    expect(() => createDb(`postgres://agrippa:${hex}@postgres:5432/agrippa`)).not.toThrow();
  });

  it("still reports an unset DATABASE_URL distinctly", () => {
    expect(() => createDb(undefined)).toThrow(/DATABASE_URL is not set/);
  });
});
