# Voice dictation

The T3 voice composer records audio locally, sends it to an OpenWhispr Whisper service on the
same computer, and inserts the returned transcript into the composer. The desktop build can also
send configured start and end keybinds to the focused desktop application on Linux.

## One-click setup

Open **Settings** → **General** → **Dictation microphone**, then choose **Set up with agent**. T3
starts a dedicated setup thread in the primary project. The setup agent checks the machine running
T3, configures the local transcription service where possible, verifies microphone access, and
reports any step that still needs your approval.

The setup agent does not modify T3 source code. It may need your approval for package installation,
desktop permissions, or other host-level changes. If you are using a remote T3 environment, the
agent runs on that remote machine; the microphone and OpenWhispr service must be reachable from the
computer running the T3 client instead.

## Requirements

- A T3 desktop build with voice dictation enabled.
- A local OpenWhispr Whisper service listening at `http://127.0.0.1:8178/inference`. The endpoint
  accepts a multipart audio file and returns JSON with a `text` field.
- Microphone permission for the T3 desktop app or browser.
- On Linux, `ydotool` plus the user permissions needed to inject the configured start/end keybinds.
  Key injection is unavailable in browser-only or non-Linux clients, but microphone transcription
  can still work there when the local service is reachable.

## Configure T3

1. In **Settings** → **General** → **Dictation microphone**, click **Detect** and grant microphone
   permission when prompted.
2. Select the microphone to use, or leave **System default** selected.
3. Under **Dictation keybinds**, click **Record shortcut** for Start or End and press the complete
   chord. The recorder captures modifier-only chords such as `Ctrl+Shift`; release the keys to
   save, or press Escape to cancel.
4. Return to the composer and click the microphone button. Recording starts after permission is
   granted, and the transcript is inserted when the local Whisper service returns text.

If transcription fails, check that OpenWhispr is running on the same machine as the browser or
desktop client and that `http://127.0.0.1:8178/inference` responds. If keybinds do not reach the
focused application on Linux, check that `ydotool` is installed and its input daemon is running
with permission for your user.
