/**
 * Delivery — the only part of BlueSpace that writes to the captain's repos.
 *
 * `landTask` merges one verified task's branch into the project's integration
 * branch (`blue/dev`, never `main`); `pendingDelivery` reports how much verified
 * work is sitting there waiting for a pull request the captain opens by hand.
 *
 * Both are used from exactly two places — `blue land` in `src/cli/index.ts` and
 * Helm's `land_task` / `delivery_status` in `src/agents/helm/tools.ts` — which
 * is the whole reason they live behind a module boundary instead of inside
 * either one.
 */

export { LandRefusedError, landTask } from './land.js';
export type { LandDeps, LandReport } from './land.js';

export { pendingDelivery, pullRequestCommand } from './delivery.js';
export type { DeliveredTask, DeliveryOptions, PendingDelivery } from './delivery.js';
