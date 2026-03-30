export { SessionHandle, SCREENSHOTS_DIR } from "./session.js"
export type { SessionConfig, SessionEventCallback, SessionDoneCallback } from "./session.js"
export { Observer } from "./observer.js"
export type { TextCaptureCallback } from "./observer.js"
export {
  buildContextPrompt,
  buildExecutionPrompt,
  prepareWorkspace,
  removeWorkspace,
  resolveDefaultBranch,
  bootstrapDependencies,
  cleanBuildArtifacts,
  dirSizeBytes,
  downloadPhotos,
  prepareFanInBranch,
  mergeUpstreamBranches,
} from "./session-manager.js"
export type { ActiveSession, PendingTask } from "./session-manager.js"
export { LandingManager } from "./landing-manager.js"
export { writeSessionLog } from "./session-log.js"
export type { SessionLogEntry } from "./session-log.js"
