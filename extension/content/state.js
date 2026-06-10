const VIDEO_MARK = "data-audio-check-video-monitor";
const DEFAULTS = {
  enabled: true,
  autoNextOnEnded: true,
  autoPlayNextVideo: true,
  preventSleep: true,
  notifyOnPause: true,
  notifyOnEnded: true,
  notifyOnStalled: true,
  pauseDebounceSeconds: 3
};

let settings = { ...DEFAULTS };
let videoSeq = 0;
const timers = new WeakMap();
const lastProgress = new WeakMap();
const observed = new WeakSet();
const playedVideos = new WeakSet();
const nextClicked = new WeakSet();
const endedHandled = new WeakSet();
const endedHandling = new WeakSet();
const replayedUnmarkedVideos = new WeakSet();
const contentScriptStartedAt = Date.now();
const diagnosticSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let playedSinceNavigation = false;
let jobCompleteAutoNextStarted = false;
let completedJobMarkerAutoNextPending = false;
const AUTOPLAY_KEY = "audioCheckAutoPlayNextUntil";
const AUTO_NEXT_CLAIM_KEY = "audioCheckAutoNextClaim";
const COMPLETED_JOB_MARKER_DELAY_MS = 2500;
const NEXT_SELECTORS = [
  "#prevNextFocusNext",
  "#prevNextFocusNext a",
  ".prev_next.next a",
  ".prev_next.next",
  ".jb_btn.prev_next.next",
  ".jb_btn.prev_next.next a",
  "[role='button'][onclick*='PCount.next']",
  "[onclick*='PCount.next']"
];
const NEXT_CONFIRM_SELECTORS = [
  ".popDiv .nextChapter",
  ".popBottom .nextChapter",
  "a.nextChapter[onclick*='PCount.next']"
];
const VIDEO_SELECTORS = [
  "#video_html5_api",
  "video.vjs-tech",
  "video"
];
const QUIZ_PANEL_ID = "audio-check-quiz-panel";
const REMOTE_QUIZ_KEY_PREFIX = "audioCheckRemoteQuiz:";
const REMOTE_SUBMIT_PENDING_KEY_PREFIX = "audioCheckRemoteSubmit:";
const WRONG_QUESTIONS_KEY = "audioCheckWrongQuestions";
let remoteQuizStarted = false;
let remoteCommandPollTimer = 0;
let remoteCommandBridgeGlobalOnly = null;
let remotePollMissingTargetLogged = false;
let wrongQuestionScanTimer = 0;
let wrongQuestionScanRunning = false;
let cxSecretMap = null;
let cxSecretLoading = null;
let cxSecretAttempted = false;
const runtimeErrorNotifiedAt = new Map();
let screenWakeLock = null;
let screenWakeLockRequesting = false;
let screenWakeLockRetryTimer = 0;
let screenWakeLockUnsupportedLogged = false;
let extensionKeepAwakeHeartbeatTimer = 0;

