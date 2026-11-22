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
  "deleteBody": "This cannot be undone.",
  "deleteFailed": "Could not delete this voice note. Try again.",
  "phase": {
    "recording": "Recording… {{name}} will process it after you stop.",
    "uploading": "Uploading… {{name}} will let you know when the voice note is ready.",
    "transcribing": "Transcribing… {{name}} will let you know when the voice note is ready.",
    "summarizing": "Writing the voice note… {{name}} will let you know when it is ready."
  },
  "failure": {
    "upload": "Could not upload the audio. Check your connection.",
    "transcribe": "Transcription failed. Try again later.",
    "summarize": "{{name}} could not write the summary. Try again later.",
    "unreadable": "Could not read this voice note.",
    "code": {
      "signed-out": "Your Gugu sign-in has expired. Sign in again, then retry.",
      "membership-required": "Transcribing voice notes needs a membership.",
      "model-unavailable": "Transcription is unavailable right now. Try again later.",
      "team-monthly-cap-reached": "You have used your monthly team credit limit. Only your AI use is paused; other members are not affected. Ask an administrator to raise your limit.",
      "team-credits-exhausted": "Team credits have run out. AI use is paused for everyone. Ask an administrator to top up.",
      "unreachable": "Could not reach the Gugu model service. Check your connection and try again.",
      "service-unavailable": "The Gugu service encountered an error. Try again later."
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
    "ready": "Voice note ready",
    "open": "View voice note",
    "noSpeech": "No recognizable speech this time",
    "failed": "The recording did not finish",
    "failedUpload": "Could not upload the audio. Check your connection.",
    "failedTranscribe": "Transcription failed",
    "failedSummarize": "Could not create the voice note",
    "close": "Close",
    "discard": "Discard recording",
    "discardTitle": "Discard this recording?",
    "discardBody": "What you have recorded will not be saved.",
    "discardConfirm": "Discard",
    "discardFailed": "Could not discard the recording. Try again.",
    "heldKept": " The recording is temporarily kept on your phone.",
    "sending": "Uploading to {{name}}'s runtime device…",
    "uploaded": "Uploaded to {{name}}'s runtime device. Waiting to be transcribed"
  },
  "mic": {
    "denied": "Allow microphone access in Settings",
    "permissions": "Manage permissions",
    "openSettings": "Open System Settings",
    "deniedPhone": "Microphone is off. Turn it on in Me → Device control.",
    "missing": "No microphone found. Connect one and try again.",
    "failed": "Could not start recording. Try again.",
    "interrupted": "Recording was interrupted. What was recorded will still be processed.",
    "busy": "Another voice note is being recorded."
  },
  "meeting": {
    "heading": "Meeting starting soon",
    "startRecording": "Start recording",
    "dismiss": "Dismiss",
    "recording": "Recording",
    "error": "Could not start recording. Try again.",
    "setting": "Meeting reminders",
    "settingDescription": "Remind you to record when a meeting on this device's calendar is about to start.",
    "needsCalendar": "Connect Calendar first in Connected apps → This device.",
    "calendarUnreadable": "Could not read this device's calendar."
  }
} as const;
