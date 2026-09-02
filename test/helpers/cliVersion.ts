/**
 * The Claude Code CLI version every real-CLI expectation in this suite was
 * probed against — and the only place it is written down.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * Three test files pin this version: `isolation.test.ts` (the sandbox fence),
 * `dev-loop-real-cli.test.ts` (the Developer cannot commit) and
 * `agents-real-cli.test.ts` (`--tools ""` grants no tools). Each held its own
 * copy of the constant. Three copies of a security-relevant number is a drift
 * hazard in one direction only: someone re-probes and bumps the file they were
 * looking at, the other two keep asserting a version nobody has verified, and
 * the suite goes green while two of the three claims are stale.
 *
 * One constant, three importers. Bumping it is therefore an explicit decision
 * to re-probe all three.
 *
 * ============================================================================
 * HOW TO BUMP IT
 * ============================================================================
 * Not by editing this line. The pin is the record of a probe, so:
 *
 *   1. `npm run test:isolation`                       (~$0.036, two arenas)
 *   2. `FACTORY_REAL_CLI=1 npx vitest run \
 *        test/integration/agents-real-cli.test.ts \
 *        test/integration/dev-loop-real-cli.test.ts`  (~$0.05)
 *   3. Confirm every escape in `MUST_BE_BLOCKED` still reports EPERM, `git add`
 *      still fails, and the Developer still leaves a dirty tree.
 *   4. Only then change the constant, and record the new version plus what was
 *      re-proved in the plan's delivery ledger.
 *
 * A green suite after step 4 without steps 1–3 is exactly the false confidence
 * ADR-003 warns about.
 */
import { execFileSync } from 'node:child_process';

/**
 * The probed version. Bump only with fresh probe evidence — see above.
 *
 * Probed against on macOS 24.6.0: 2.1.220 (original calibration, spec §4.2/§4.5),
 * then re-probed at 2.1.258 with all seven escapes still EPERM in both arenas.
 */
export const PROBED_CLI_VERSION = '2.1.258';

/**
 * What `claude --version` actually reports right now.
 *
 * Every probe log line uses this rather than {@link PROBED_CLI_VERSION}. The
 * two are equal only while the pin assertion passes, and a log that prints the
 * pin claims evidence for a version the probe may not have run against — which
 * is the one thing these logs exist to establish.
 */
export function installedCliVersion(): string {
  return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
}
