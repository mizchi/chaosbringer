/**
 * Incident replays. Each drill reproduces the SHAPE — onset, peak,
 * cascade, recovery curve — of a real, publicly-postmortemed AWS outage.
 * The wall-clock duration is compressed but the relative proportions of
 * each phase are preserved.
 *
 * Why this catalog exists: chaos drills that target generic patterns
 * ("inject 50% throttling") teach generic lessons. Drills that replay a
 * specific incident teach the specific anti-patterns that incident exposed:
 * retry amplification (2015 DDB, 2021 us-east-1), asymmetric recovery
 * (2017 S3), hidden upstream dependency (2020 Kinesis).
 *
 * Adding new replays: read the recipe at
 * docs/recipes/incident-replay.md for the methodology (extract phases
 * from the post-mortem, map verbatim error-rate / latency claims to
 * `Inject` shapes, document the cascade).
 */
export { aws_2015_09_20_dynamodb } from "./aws-2015-09-20-dynamodb.ts";
export type { AWS20150920Options } from "./aws-2015-09-20-dynamodb.ts";

export { aws_2017_02_28_s3 } from "./aws-2017-02-28-s3.ts";
export type { AWS20170228Options } from "./aws-2017-02-28-s3.ts";

export { aws_2020_11_25_kinesis } from "./aws-2020-11-25-kinesis.ts";
export type { AWS20201125Options } from "./aws-2020-11-25-kinesis.ts";

export { aws_2021_12_07_useast1 } from "./aws-2021-12-07-useast1.ts";
export type { AWS20211207Options } from "./aws-2021-12-07-useast1.ts";

export { compressTimeline } from "./_compress.ts";
export type { PhaseTemplate } from "./_compress.ts";
