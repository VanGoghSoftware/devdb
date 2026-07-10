import { execFile } from "node:child_process";

// The load-bearing phrase in a classifyPgVersionError() incompatibility message. Referenced by BOTH
// the generator (below) and isIncompatibilityError() so the write and the read-back can't drift.
const INCOMPATIBLE_RUNTIME_MARKER = "is incompatible with this runtime image";

// A failed `postgres --version` whose stderr shows the dynamic linker could not resolve the
// binary's shared libraries means the build was linked against a DIFFERENT OS base than this
// runtime image (e.g. a Debian-bullseye Neon compute build — OpenSSL 1.1 / ICU 67 — on a
// bookworm container). Rewrite THAT specific failure into an actionable message naming the
// missing soname; leave every other failure (non-zero exit, unparseable output) as a raw
// passthrough. Node's execFile appends the child's stderr to err.message, so the loader line
// ("… error while loading shared libraries: libssl.so.1.1: cannot open shared object …") is
// already in `rawMessage` — no separate stderr capture needed.
export function classifyPgVersionError(pgbinPath: string, rawMessage: string): string {
  // A build linked against a different OS base trips the dynamic linker in one of a few shapes:
  // a missing shared OBJECT ("error while loading shared libraries: libssl.so.1.1: cannot open
  // shared object"), or a versioned SYMBOL/lib the runtime's own libs don't provide ("version
  // `GLIBC_2.34' not found", "symbol lookup error", "… OPENSSL_3 not found"). Classify all of
  // them; leave a non-loader failure (bad exit, unparseable output) as a raw passthrough.
  const loaderFailure =
    /error while loading shared libraries|cannot open shared object|symbol lookup error/i.test(rawMessage) ||
    /\b(?:GLIBC|GLIBCXX|CXXABI|OPENSSL|LIBSSL|LIBCRYPTO)_[0-9.]+'?\s+not found/i.test(rawMessage);
  if (loaderFailure) {
    const lib = /([\w.+-]+\.so(?:\.\d+)*): cannot open shared object/i.exec(rawMessage)?.[1];
    return `${pgbinPath} ${INCOMPATIBLE_RUNTIME_MARKER}` +
      (lib !== undefined ? ` (missing shared library ${lib})` : "") +
      " — the build targets a different OS base than this container";
  }
  return `${pgbinPath} --version failed: ${rawMessage}`;
}

// Read-back predicate over a failed pg_build row's STORED `error` column: was the failure an
// image/runtime-base incompatibility (a build linked against a different OS base — libssl.so.1.1 on
// bookworm, a GLIBC/OPENSSL symbol mismatch, …), as opposed to a transient one (gate timeout, disk,
// a registry 404, an activate malfunction)? The stored string is classifyPgVersionError()'s own
// output for that class, so we match its marker phrase — an incompatibility is permanent for THIS
// runtime, so check() must never surface such a `latest` as an available update (re-pulling it
// re-fails identically). Transient failures are NOT matched: they might yet install a genuine newer
// minor, so check() keeps offering them (as "unverified", not "confirmed").
export function isIncompatibilityError(storedError: string | null | undefined): boolean {
  return storedError != null && storedError.includes(INCOMPATIBLE_RUNTIME_MARKER);
}

// Parses `postgres (PostgreSQL) 16.9` and Debian-suffixed variants. Spawn (not shell) — the
// path came from OUR registry rows, but never interpolate paths into a shell string anyway.
export function detectPostgresVersion(pgbinPath: string): Promise<{ major: number; minor: number }> {
  return new Promise((resolve, reject) => {
    execFile(pgbinPath, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(new Error(classifyPgVersionError(pgbinPath, err.message)));
      const m = /PostgreSQL\)\s+(\d+)\.(\d+)/.exec(stdout);
      if (!m) return reject(new Error(`unparseable postgres version output: ${stdout.trim().slice(0, 200)}`));
      resolve({ major: Number(m[1]), minor: Number(m[2]) });
    });
  });
}
