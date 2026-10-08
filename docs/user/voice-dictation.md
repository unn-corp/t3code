# Voice dictation

Arcwright Code records audio on the device you are using, uploads the clip through your authenticated
connection to the composer's environment, and inserts the returned text into the draft. That
environment processes the clip with its own OpenWhispr Whisper service, just as it does for a
recording made on that computer. This applies to both the main and annotation composers.

Your client device does not need OpenWhispr or a local transcription service installed. It needs
microphone access; transcription must be configured on the environment you are accessing. If that
environment's service is unavailable, dictation reports the problem. The desktop build can also
send configured start and end keybinds to the focused desktop application on Linux.

## One-click setup

Open **Settings** → **General** → **Dictation microphone**, then choose **Set up with agent**. T3
starts a dedicated setup thread in the primary project. The setup agent checks the machine running
T3, configures the local transcription service where possible, verifies microphone access, and
reports any step that still needs your approval.

The setup agent does not modify T3 source code. It may need your approval for package installation,
desktop permissions, or other host-level changes. If you are using a remote T3 environment, the
agent runs on that remote machine. Run OpenWhispr on each T3 server where you want to dictate;
the microphone stays on the phone or computer running the client.

## Requirements

The desktop preview browser can also request microphone access for the local app at
`http://127.0.0.1:5274`. Choose **Allow microphone** or **Deny** when prompted. The choice is
saved for that browser profile; incognito choices last only for the session. Camera access is
blocked. Clear the profile's site data to choose again. This permission is separate from T3's
composer dictation settings.

- A connected T3 desktop, web, or PWA client with voice dictation enabled.
- An OpenWhispr Whisper service on the connected T3 server, listening at `http://127.0.0.1:8178/inference`. The endpoint
  accepts a multipart audio file and returns JSON with a `text` field.
- Microphone permission for the T3 desktop app or browser.
- On Linux, `ydotool` plus the user permissions needed to inject the configured start/end keybinds.
  Key injection is unavailable in browser-only or non-Linux clients, but microphone transcription
  uses the connected server there.

## Configure T3

1. In **Settings** → **General** → **Dictation microphone**, click **Detect** and grant microphone
   permission when prompted.
2. Select the microphone to use, or leave **System default** selected.
3. Under **Dictation keybinds**, click **Record shortcut** for Start or End and press the complete
   chord. The recorder captures modifier-only chords such as `Ctrl+Shift`; release the keys to
   save, or press Escape to cancel.
4. Return to the composer and click the microphone button. Recording starts after permission is
   granted. Click again to stop and transcribe on the connected server.
5. Click the microphone while startup or transcription is pending to cancel. A stalled
   transcription stops after about a minute so you can try again.

You can also dictate a preview annotation in the desktop app. Click **Annotate** to capture the
current page into a saved modal, then use its microphone to add your comment. It uses the same
microphone and transcription settings as the main composer. Finish or cancel transcription
before attaching or sending the annotation.

The captured screenshot, element details, marks, and comment stay in the modal when the preview
navigates or reloads. A completed capture also restores after an app reload. **Close**, Escape,
and clicking outside the modal ask you to confirm discarding it; **Keep editing** preserves it.
Use **Attach to draft** or **Send** when you are finished. Sending requires the original thread
to be open; otherwise you can attach the annotation to that thread's draft. Discarding the
annotation also cancels dictation.
