export default {
  "title": "Voice notes",
  "untitled": "Voice note",
  "record": "Record a voice note",
  "week": {
    "thisWeek": "This week",
    "lastWeek": "Last week"
  },
  "delete": "Delete",
  "deleteTitle": "Delete “{{name}}”?",
  "deleteBody": "This can't be undone.",
  "deleteFailed": "Couldn't delete this voice note. Try again.",
  "phase": {
    "recording": "Recording… {{name}} will sort it out once you stop.",
    "uploading": "Uploading… {{name}} will let you know when the voice note is ready.",
    "transcribing": "Transcribing… {{name}} will let you know when the voice note is ready.",
    "summarizing": "Writing the voice note… {{name}} will let you know when it's ready."
  },
  "failure": {
    "upload": "Couldn't upload the audio. Check your connection.",
    "transcribe": "Transcription failed. Try again later.",
    "summarize": "{{name}} couldn't write the summary. Try again later.",
    "unreadable": "This voice note can't be read anymore.",
    "code": {
      "signed-out": "Your Gugu sign-in has expired. Sign in again, then retry.",
      "membership-required": "Transcribing voice notes needs a membership.",
      "model-unavailable": "Transcription is unavailable right now. Try again later.",
      "unreachable": "Can't reach Gugu's models. Check your connection.",
      "service-unavailable": "Something went wrong on Gugu's side. Try again later."
    }
  },
  "retry": "Retry",
  "bar": {
    "starting": "Starting to record…",
    "cancel": "Cancel",
    "recording": "Recording",
    "paused": "Paused",
    "pause": "Pause recording",
    "resume": "Resume recording",
    "stop": "Stop recording",
    "noSound": "No sound detected",
    "noSoundDescription": "Check your microphone and audio input.",
    "uploading": "Processing audio…",
    "transcribing": "Transcribing audio…",
    "summarizing": "Writing the voice note…",
    "ready": "Your voice note is ready",
    "open": "View voice note",
    "noSpeech": "No recognizable speech this time",
    "failed": "The recording didn't finish",
    "failedUpload": "Couldn't upload the audio. Check your connection.",
    "failedTranscribe": "Transcription failed",
    "failedSummarize": "Couldn't create the voice note",
    "close": "Close",
    "discard": "Discard recording",
    "discardTitle": "Discard this recording?",
    "discardBody": "What you've recorded won't be saved.",
    "discardConfirm": "Discard",
    "discardFailed": "Couldn't discard it. Try again.",
    "heldKept": " The recording is kept on your phone.",
    "sending": "Sending to {{name}}…",
    "uploaded": "Sent to {{name}}. Waiting to be transcribed"
  },
  "mic": {
    "denied": "Allow microphone access in Settings",
    "permissions": "Manage permissions",
    "openSettings": "Open System Settings",
    "deniedPhone": "Microphone is off. Manage it in Me → Device control.",
    "missing": "No microphone found. Connect one and try again.",
    "failed": "Couldn't start recording. Try again.",
    "interrupted": "Recording was interrupted. What was recorded will still be processed.",
    "busy": "Another voice note is being recorded."
  },
  "meeting": {
    "heading": "Meeting starting soon",
    "startRecording": "Start recording",
    "dismiss": "Dismiss",
    "recording": "Recording",
    "error": "Couldn't start recording. Try again.",
    "setting": "Meeting reminders",
    "settingDescription": "Remind you to record when a meeting on this computer's calendar is about to start.",
    "needsCalendar": "Connect Calendar first in Connected apps → This device."
  }
} as const;
