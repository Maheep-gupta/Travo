// Whether the data on screen is current (spec 3.5, 14.2) and what the offline
// banner says when it isn't. The rules are pure and live in @mc/domain so the
// future Expo app shares them; re-exported here for the web app's imports.
export {
  FETCH_GRACE_MS,
  MAX_FETCH_RETRIES,
  RETRY_DELAY_CAP_MS,
  STALE_DATA_AFTER_MS,
  connectionMessage,
  connectionState,
  fetchFailureOf,
  fetchRetryDelay,
  formatDataTime,
  isStatusQuery,
  shouldRetryFetch,
  summarizeQueries,
  type ConnectionState,
  type FetchFailure,
  type FetchSummary,
  type QueryLike,
} from "@mc/domain";
