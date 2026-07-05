import { describe, expect, it } from "vitest";
import { classifyPgVersionError } from "../src/compute/builds/version.js";

// A pulled Neon compute build linked against a DIFFERENT Debian base than this runtime image
// (e.g. a bullseye build — OpenSSL 1.1 / ICU 67 — on a bookworm container) fails `postgres
// --version` at the dynamic-linker stage. Node's execFile appends the loader's stderr to the
// error message, so classifyPgVersionError works off that raw string alone.
describe("classifyPgVersionError", () => {
  const pgbin = "/data/pg_builds/v14/.tmp-ee99278f4a49020f/bin/postgres";

  it("rewrites a shared-library load failure into an actionable incompatible-runtime message naming the lib", () => {
    const raw = `Command failed: ${pgbin} --version\n${pgbin}: error while loading shared libraries: libssl.so.1.1: cannot open shared object file: No such file or directory`;
    const msg = classifyPgVersionError(pgbin, raw);
    expect(msg).toMatch(/incompatible with this runtime image/);
    expect(msg).toContain("libssl.so.1.1");
    expect(msg).toMatch(/different OS base/);
    expect(msg).not.toMatch(/Command failed/);
  });

  it("names an ICU (or any other) missing .so too", () => {
    const raw = `Command failed: ${pgbin} --version\n${pgbin}: error while loading shared libraries: libicui18n.so.67: cannot open shared object file: No such file or directory`;
    expect(classifyPgVersionError(pgbin, raw)).toContain("libicui18n.so.67");
  });

  it("still classifies a loader failure even when the specific soname isn't parseable", () => {
    const raw = "error while loading shared libraries: cannot open shared object file";
    const msg = classifyPgVersionError(pgbin, raw);
    expect(msg).toMatch(/incompatible with this runtime image/);
    expect(msg).not.toMatch(/missing shared library/); // no lib name to name
  });

  it("classifies a versioned-symbol / GLIBC base mismatch (no missing-soname wording)", () => {
    const raw = `Command failed: ${pgbin} --version\n${pgbin}: /lib/aarch64-linux-gnu/libc.so.6: version \`GLIBC_2.38' not found (required by ${pgbin})`;
    const msg = classifyPgVersionError(pgbin, raw);
    expect(msg).toMatch(/incompatible with this runtime image/);
    expect(msg).toMatch(/different OS base/);
  });

  it("classifies a symbol lookup error (undefined versioned symbol)", () => {
    const raw = `Command failed: ${pgbin} --version\n${pgbin}: symbol lookup error: ${pgbin}: undefined symbol: SSL_CTX_new, version OPENSSL_3.0.0`;
    expect(classifyPgVersionError(pgbin, raw)).toMatch(/incompatible with this runtime image/);
  });

  it("leaves an unrelated --version failure as the raw passthrough (not misclassified)", () => {
    const raw = "Command failed: … exited with code 1";
    const msg = classifyPgVersionError(pgbin, raw);
    expect(msg).toBe(`${pgbin} --version failed: ${raw}`);
    expect(msg).not.toMatch(/incompatible/);
  });
});
