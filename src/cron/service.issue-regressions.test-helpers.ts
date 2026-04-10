import { vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createDefaultIsolatedRunner,
  createDeferred,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  noopLogger,
  setupCronRegressionFixtures,
  topOfHourOffsetMs,
  writeCronJobs,
  writeCronStoreSnapshot,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { CronService } from "./service.js";

export type CronServiceOptions = ConstructorParameters<typeof CronService>[0];

export const setupCronIssueRegressionFixtures = () =>
  setupCronRegressionFixtures({ prefix: "cron-issues-" });

export {
  createAbortAwareIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  createDeferred,
  noopLogger,
  topOfHourOffsetMs,
  writeCronJobs,
  writeCronStoreSnapshot,
};

export async function startCronForStore(params: {
  storePath: string;
  cronEnabled?: boolean;
  enqueueSystemEvent?: CronServiceOptions["enqueueSystemEvent"];
  requestHeartbeatNow?: CronServiceOptions["requestHeartbeatNow"];
  runIsolatedAgentJob?: CronServiceOptions["runIsolatedAgentJob"];
  onEvent?: CronServiceOptions["onEvent"];
}) {
  const enqueueSystemEvent =
    params.enqueueSystemEvent ?? (vi.fn() as unknown as CronServiceOptions["enqueueSystemEvent"]);
  const requestHeartbeatNow =
    params.requestHeartbeatNow ?? (vi.fn() as unknown as CronServiceOptions["requestHeartbeatNow"]);
  const runIsolatedAgentJob = params.runIsolatedAgentJob ?? createDefaultIsolatedRunner();

  const cron = new CronService({
    cronEnabled: params.cronEnabled ?? true,
    enqueueSystemEvent,
    log: noopLogger,
    requestHeartbeatNow,
    runIsolatedAgentJob,
    storePath: params.storePath,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
  await cron.start();
  return cron;
}
