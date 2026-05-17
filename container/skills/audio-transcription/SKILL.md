---
name: audio-transcription
description: Transcribe WhatsApp audio recordings and other audio files with OpenAI. Use whenever a message includes an audio attachment or the user asks about audio content.
allowed-tools: Bash(curl:*), Bash(mkdir:*), Bash(tee:*), Bash(date:*)
---

# Audio Transcription

Incoming WhatsApp audio appears in messages like:

```text
[audio: audio-...ogg - saved to /workspace/inbox/.../audio-...ogg]
```

Use OpenAI transcription with the `OPENAI_API_KEY` already available in the container environment. Never print or expose the key.

```bash
curl -sS https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "model=gpt-4o-mini-transcribe" \
  -F "file=@/workspace/inbox/<message-id>/<filename>.ogg" \
  -F "response_format=text"
```

If the user sent audio as part of a normal chat, transcribe it first, then answer from the transcript. For longer recordings, save a transcript under `/workspace/agent/transcripts/` only when it will help future work.
