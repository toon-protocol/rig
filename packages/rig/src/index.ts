/**
 * @toon-protocol/rig — Git-to-TOON write path core.
 *
 * Pure builders for git objects (blob/tree/commit/tag with SHA-1 envelope
 * hashing) and NIP-34 events (repo announcement/refs, issues, comments,
 * patches, statuses), plus GitRepoReader (execFile git plumbing for reading
 * a local repo), the remote-state reader (kind:30617/30618 relay fetch +
 * Arweave Git-SHA resolution), and the push planner/executor
 * (planPush/executePush) behind the Publisher interface. No signing or
 * payment code lives here — the daemon (#227) and standalone (#228)
 * Publisher implementations arrive in the follow-up tickets of epic
 * toon-client#222.
 */

export {
  MAX_OBJECT_SIZE,
  createGitBlob,
  createGitCommit,
  createGitTag,
  createGitTree,
  hashGitObject,
  type GitObject,
  type GitObjectType,
} from './objects.js';

export {
  COMMENT_KIND,
  MAINTAINERS_TAG,
  PAYOUT_TAG,
  REPOSITORY_STATE_KIND,
  authorizedStatusAuthors,
  buildComment,
  buildIssue,
  buildPatch,
  buildRepoRefs,
  buildStatus,
  isValidEvmPayoutAddress,
  parseMaintainers,
  parsePayout,
  type PayoutChain,
  type PayoutPointer,
  type StatusKind,
  type UnsignedEvent,
} from './nip34-events.js';

export {
  amendRepoAnnouncement,
  announcedEuc,
  buildRepoAnnouncement,
  conformanceEdits,
  describeAnnouncementDiff,
  diffAnnouncementTags,
  earliestUniqueCommit,
  EARLIEST_UNIQUE_COMMIT_MARKER,
  RELAYS_TAG,
  WEB_TAG,
  type AnnouncementDiff,
  type AnnouncementEdits,
  type ConformanceFacts,
  type ExistingAnnouncement,
  type RootCommitSource,
} from './repo-announcement.js';

export {
  GitError,
  GitRepoReader,
  type GitRef,
  type ObjectStat,
  type ObjectWithPath,
  type ReadGitObject,
  type ReadObjectsResult,
  type RepoRefs,
  type StatObjectsResult,
} from './repo-reader.js';
export {
  fetchRemoteState,
  queryRelay,
  type FetchRemoteStateOptions,
  type NostrEvent,
  type NostrFilter,
  type RemoteState,
  type WebSocketFactory,
  type WebSocketLike,
} from './remote-state.js';

// The #278 read path: gateway download + verification, closure walking, the
// clone/fetch collection engine, and repo materialization via git plumbing.
export {
  DEFAULT_CONCURRENCY,
  ObjectIntegrityError,
  downloadGitObjects,
  fetchTxBytes,
  referencedShas,
  verifyObjectBody,
  walkClosure,
  type ClosureResult,
  type DownloadOptions,
  type DownloadResult,
  type FetchLike,
  type FetchedObject,
  type GatewayFetchOptions,
} from './object-fetch.js';
export {
  collectRepoObjects,
  missingObjectsMessage,
  type CollectRepoObjectsOptions,
  type CollectRepoObjectsResult,
  type MissingObject,
} from './read-pipeline.js';
export {
  ObjectWriteMismatchError,
  isSafeRefname,
  setHeadSymref,
  updateRef,
  writeGitObject,
  writeGitObjects,
} from './materialize.js';
export { hexToNpub, npubToHex, ownerToHex } from './npub.js';

export {
  type FeeRates,
  type GitObjectUpload,
  type PublishReceipt,
  type Publisher,
  type UploadReceipt,
} from './publisher.js';

export {
  serializeEventReceipt,
  serializeFeeEstimate,
  serializePushPlan,
  serializePushResult,
  type GitCommentRequest,
  type GitErrorEnvelope,
  type GitEstimateRequest,
  type GitEstimateResponse,
  type GitEventResponse,
  type GitFeeEstimate,
  type GitIssueRequest,
  type GitPatchRequest,
  type GitPlannedObject,
  type GitPublishReceipt,
  type GitPushRequest,
  type GitPushResponse,
  type GitRefUpdate,
  type GitRepoAddr,
  type GitStatusRequest,
  type GitStatusValue,
  type GitUploadStep,
} from './routes.js';

export {
  NonFastForwardError,
  OversizeObjectsError,
  executePush,
  planPush,
  type ExecutePushOptions,
  type OversizeObject,
  type PlanPushOptions,
  type PlannedObject,
  type PushFeeEstimate,
  type PushPlan,
  type PushResult,
  type RefUpdate,
  type RefUpdateKind,
  type RejectedRefUpdate,
  type UploadStepResult,
} from './push.js';

// #52: factory job adapter — job → sandcastle milestones → paid increments.
export {
  FACTORY_JOB_FEEDBACK_KIND,
  FACTORY_JOB_REQUEST_KIND,
  FACTORY_JOB_RESULT_KIND,
  buildIncrementOfferEvent,
  buildNarrationEvent,
  buildQuoteEvent,
  buildResultEvent,
  parseFactoryJobRequest,
  type BuildIncrementOfferOptions,
  type BuildNarrationOptions,
  type BuildResultEventOptions,
  type EncryptedArtifactRef,
  type FactoryJobOutcome,
  type FactoryJobRequest,
  type RelayEvent,
} from './factory-job-events.js';
// #53: reproducible gate result per increment — the objective floor.
export {
  gatePassed,
  type GateCheck,
  type GateResult,
} from './factory-job-gate.js';
export {
  planFactoryJob,
  type FactoryMilestone,
  type FactoryTicket,
  type IncrementSpec,
} from './factory-job-plan.js';
export {
  type EncryptedArtifact,
  type JobDeliveryPort,
  type OfferedIncrement,
} from './factory-job-delivery.js';
export {
  executeFactoryJob,
  type ExecuteFactoryJobOptions,
  type FactoryJobExecution,
  type FactoryJobHooks,
  type FactoryJobWork,
} from './factory-job-execute.js';

// ---------------------------------------------------------------------------
// Relay-native CI (#125): NIP-C1 events, secrets, trust, the Runner seam,
// and workflow discovery. The act runner (child_process + Docker) and the
// coordinator loop stay CLI-side; import them from the `rig ci` code paths.
// ---------------------------------------------------------------------------
export {
  CI_ADVERTISEMENT_KIND,
  CI_JOB_RESULT_KIND,
  CI_MANUAL_TRIGGER_KIND,
  CI_MAX_ADVERTISEMENT_TTL,
  CI_MAX_PROGRESS_TTL,
  CI_RUNNER_FAMILY,
  CI_SECRET_UPDATE_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
  CI_SOFTWARE,
  CI_WORKFLOW_PROGRESS_KIND,
  CI_WORKFLOW_RESULT_KIND,
  buildCiAdvertisement,
  buildCiJobResult,
  buildCiManualTrigger,
  buildCiSecretUpdate,
  buildCiServiceRequest,
  buildCiServiceStop,
  buildCiWorkflowProgress,
  buildCiWorkflowResult,
  commonTriggerTags,
  controlOrder,
  isCiConclusion,
  parseCiAdvertisement,
  parseCiJobResult,
  parseCiManualTrigger,
  parseCiSecretUpdate,
  parseCiServiceControl,
  parseCiTriggerContext,
  parseCiWorkflowProgress,
  parseCiWorkflowResult,
  parseRepoAddress,
  repoAddress,
  selectServiceRequests,
  type CiAdmissionPolicy,
  type CiAdvertisement,
  type CiAdvertisementInput,
  type CiArtifact,
  type CiBillingPolicy,
  type CiConclusion,
  type CiExecutionPolicy,
  type CiJobQuote,
  type CiJobResult,
  type CiJobResultInput,
  type CiManualTrigger,
  type CiPrContext,
  type CiProgressStatus,
  type CiProvenance,
  type CiSecretUpdate,
  type CiSecretUpdateArgs,
  type CiTriggerContext,
  type CiTriggerReason,
  type CiWorkflowProgress,
  type CiWorkflowProgressInput,
  type CiWorkflowRef,
  type CiWorkflowResult,
  type CiWorkflowResultInput,
  type RepoAddress,
  type SelectServiceRequestsOptions,
  type SelectedServiceRequests,
  type ServiceControl,
} from './ci/nip-c1-events.js';
export {
  MAX_SECRET_CIPHERTEXT_BYTES,
  MAX_SECRET_NAMES,
  MAX_SECRET_PLAINTEXT_BYTES,
  MAX_SECRET_VALUE_BYTES,
  RESERVED_SECRET_NAMES,
  SECRET_NAME_RE,
  applySecretUpdate,
  assertSecretUpdateShape,
  decryptSecretUpdate,
  effectiveSecrets,
  encryptSecretUpdate,
  generateSecretsKey,
  validateSecretUpdate,
  type SecretInventory,
  type SecretInventoryEntry,
  type SecretUpdatePlaintext,
} from './ci/secrets.js';
export {
  CI_TRUST_ORDER,
  deriveTrustLevel,
  isCiTrustLevel,
  trustAtLeast,
  type CiTrustLevel,
  type DeriveTrustLevelArgs,
} from './ci/trust.js';
export {
  FakeRunner,
  defaultFakeRunResult,
  type FakeRunnerScript,
  type Runner,
  type RunnerArtifact,
  type RunnerJobResult,
  type RunnerRequest,
  type RunnerRunResult,
} from './ci/runner.js';
export {
  WORKFLOW_DIRS,
  discoverWorkflows,
  matchesPullRequest,
  matchesPush,
  parseWorkflow,
  refMatchesPatterns,
  sha256Hex,
  type DiscoveredWorkflow,
  type RefFilters,
  type WorkflowJob,
  type WorkflowTriggers,
} from './ci/workflows.js';
export {
  assembleCiStatus,
  type CiStatusJob,
  type CiStatusReport,
  type CiStatusRun,
  type CiStatusSummary,
} from './cli/ci-status.js';
