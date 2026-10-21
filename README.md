# MagickVoice X NeuraCX (Dev)

A dev demo of an AI voice bot on inbound phone calls. Callers ring a NeuraCX number, the call audio streams
to this Node.js server, and Gemini Live (`gemini-3.8-live`) holds the conversation. A web UI sets up the
bot, shows live transcripts and outcomes, and can place test calls from the browser. Settings, call
history and hotel bookings are kept in SQLite.

## Use cases

The bot has two use cases. Pick the live one under **Bot setup → Use case for new calls**; it is saved
straight away and applies from the next call (calls in progress keep theirs). The header shows which one
is live, and each call in the list is tagged with the use case it ran.

### Golden Visa FAQ

A FAQ assistant. It doesn't look up or verify anyone's application.

1. Greets the caller and asks how it can help.
2. Answers Golden Visa questions only from its **knowledge base**. Anything the knowledge base doesn't
   cover goes to the support contact (or a transfer, if a transfer number is set). Unrelated questions
   are politely declined.
3. Records an outcome for each call (`informed`, `needs_assistance`, `escalated`, `no_response`,
   `caller_hung_up`, `other`) and ends the call politely.

The knowledge base is the published Golden Visa FAQ, kept in `knowledge/golden-visa-faq.txt` (eligibility,
application process, fees, timelines, family sponsorship, renewal). Queries it doesn't cover go to the
support contact from the FAQ: ADGoldenVisa@adro.gov.ae, or TAMM on 800 555 (+971 2 666 4442 from abroad).
Both can be changed in the UI.

### Taj Dubai reservations (demo data)

A hotel reservations line that makes real bookings in the demo database:

- checks availability for dates and guests, and quotes the nightly rate and total in AED;
- books a room after reading back a summary, and gives a confirmation number;
- looks up a booking by confirmation number and name, and cancels it after the caller confirms;
- answers hotel questions only from its knowledge base; payment is never taken on the phone.

Extra outcomes: `reservation_made` and `reservation_cancelled`.

**The hotel info, rooms and rates are made-up demo data**, to be replaced with the real ones. The hotel
info is in `knowledge/taj-dubai-demo.txt`; rooms and rates are edited in the UI under **Rooms & rates**
(Reset demo rooms puts the demo set back). Bookings are stored in SQLite and listed under **Taj Dubai
reservations** in the UI, which updates live and lets staff cancel a booking.

Both use cases: the bot checks in after 8 s of caller silence (twice) then ends politely; it asks the
caller to repeat when it can't understand; it switches language when the caller does; barge-in stops the
bot mid-sentence; a caller hanging up mid-call is recorded as `caller_hung_up`.

## Run it

Needs Node.js 22.13 or newer (24 recommended).

```
npm install
cp .env.example .env      # add GEMINI_API_KEY here, or paste it in the UI later
npm start                 # http://localhost:8080
```

NeuraCX has to reach the server over `wss://`, so expose it, for example:

```
cloudflared tunnel --url http://localhost:8080
# or: ngrok http 8080
```

The UI header shows the stream URL to use (`wss://<public-host>/stream`). When the server is public, set
`UI_PASSWORD` in `.env`, because anyone who can open the UI can change the bot, read call transcripts and
see the stream token. Locally it only warns; with `NODE_ENV=production` (as in Docker) the server won't
start without it.

## Deploy to AWS (dev setup)

One EC2 instance with an Elastic IP (static IP for your domain). Caddy sits in front of the app and gets
a Let's Encrypt certificate automatically. You need Terraform, the AWS CLI credentials, and an SSH key.

1. Fill in your `.env` locally. It is copied to the server, so set `UI_PASSWORD` (required: the UI is
   public and the container won't start without it) and `GEMINI_API_KEY`.
2. Create the server:
   ```
   cd deploy/terraform
   cp terraform.tfvars.example terraform.tfvars   # set domain, acme_email and ssh_cidr (your IP)
   terraform init && terraform apply
   ```
3. Point an A record for your domain at the `public_ip` output (or set `route53_zone_id` and Terraform
   does it).
4. Deploy the code, and again after every change:
   ```
   ./deploy/deploy.sh          # SSH_KEY=~/.ssh/other_key ./deploy/deploy.sh for a non-default key
   ```
   This rsyncs the project (with `.env`, but not your local `data/` database) to `/opt/voicebot` and runs
   `docker compose up -d --build` there. Caddy issues the certificate once DNS resolves to the server.
5. Use the `stream_url` output in NeuraCX and open the `ui_url` output.

Logs: `ssh ec2-user@<ip> 'cd /opt/voicebot/deploy && docker compose logs -f'`.

Notes:
- Port 22 is open to `ssh_cidr`. Set it to your IP (`curl -s https://checkip.amazonaws.com`, then
  `x.x.x.x/32`). If you leave the default, SSH is open to the whole internet (key-only login).
- Changing `domain` or `acme_email` rebuilds the instance with the same IP. Run `deploy.sh` again, and
  `ssh-keygen -R <ip>` first, because the server's SSH host key changes.
- The SQLite database lives in a Docker volume on the instance, so it is lost if the instance is rebuilt.
- `docker compose stop` / redeploys send `exit` on live calls first, so NeuraCX drops them cleanly.

## Point NeuraCX at it

1. In the NeuraCX portal, register the stream URL under **Developer → Webhooks** as a WebSocket URL.
   Unregistered URLs are rejected.
2. Set your inbound number's streaming WebSocket URL to the same `wss://<public-host>/stream`
   (add `?token=...` if you set `STREAM_TOKEN`). `/ws` works as an alias for `/stream`.
3. Call the number. The call shows up in the UI with its transcript and event log.

You can test without a phone: **Test from browser** in the UI acts as NeuraCX (same events, 8 kHz PCM16,
1600-byte chunks) with your mic as the caller. Use headphones. The keypad sends DTMF.

## What the server does on a call

Follows the protocol in the NeuraCX developer docs (Real-Time Audio Streaming → WebSocket Events):

| From NeuraCX | Server action |
|---|---|
| `connected` | Logged |
| `start` | Reads `room_id`, `call_id`, `cli`, `dni`, `custom_parameters`, `media_format.sample_rate`; opens the Gemini session; the bot greets first if enabled |
| `media` | Caller audio (base64 PCM16) is resampled from the call rate to 16 kHz and sent to Gemini |
| `dtmf` | Logged, and told to the bot if enabled |
| `mark` | When the goodbye turn's mark comes back, the server sends `exit` |
| `stop` | Closes the Gemini session |

Sent to NeuraCX:

- `media`: Gemini's 24 kHz audio, low-pass filtered and resampled to the call rate, in fixed chunks of
  the configured size (default 1600 bytes = 100 ms at 8 kHz). The last chunk of a turn is padded with
  silence, because NeuraCX stops the stream after 4 media frames smaller than 1600 bytes.
- `clear`: when Gemini reports the caller interrupted (barge-in).
- `mark`: after every bot turn (`turn-N`), to know when playback has finished.
- `exit`: when the bot calls `end_call` (empty `parameters`) or `transfer_call`
  (`[{ "action": "dial", "to": "<transfer number>" }]`), when you press Hang up, if Gemini fails, or
  when the server shuts down (SIGTERM/SIGINT).

Long calls: context window compression and session resumption are on. On `goAway` the server opens the
next Gemini session before dropping the old one, so calls can run past Gemini's 10 to 15 minute session
limits. If Gemini drops, it retries a few times with backoff, then hangs up.

Limits: at most `MAX_CALLS` streams at once (more get HTTP 503), and stream frames over 1 MiB close the
stream.

## Config and data

Everything is stored in SQLite at `data/voicebot.db` (`/data/voicebot.db` in Docker, on a volume):
settings, every call with its transcript, event log and outcomes, the hotel rooms and the reservations.
The schema is migrated on start.

Each use case has its own system prompt, opening instruction, knowledge base, support contact, transfer
number and voice (pick one under **Editing** in Bot setup; editing doesn't change which one is live). The
rest (model, API key, temperature, timezone, turn taking, silence handling, call control, chunk size) is
shared by both.

Only the settings you change in the UI are saved, for the shared ones and each use case's; everything
else comes from the defaults in the code and `knowledge/`. So a redeploy with a new default prompt or FAQ
takes effect, while your UI edits stay. Settings that differ from the defaults are marked "changed" in the
UI, and Save sends only what you edited. **Reset** on a use case clears that use case's edits; **Reset all**
clears every edit, and the live use case, but keeps a Gemini key saved in the UI. Settings apply to the
next call.

The system prompt accepts `{{support_contact}}`, `{{now}}`, `{{cli}}`, `{{dni}}`, `{{call_id}}`,
`{{room_id}}` and `{{custom.KEY}}` (from `custom_parameters`); the knowledge base is appended after it.

| Env var | Purpose |
|---|---|
| `GEMINI_API_KEY` | Used when no key is saved in the UI |
| `PORT` | HTTP and WebSocket port (default 8080) |
| `STREAM_TOKEN` | If set, `/stream` requires `?token=<value>` |
| `UI_PASSWORD` | UI and `/api/*` need basic auth with this password. Required when `NODE_ENV=production` |
| `DB_PATH` | SQLite file (default `./data/voicebot.db`) |
| `MAX_CALLS` | Most calls at once (default 20) |
| `TRUST_PROXY` | `1` to take the caller address from `X-Forwarded-For` (set in Docker, behind Caddy) |

Scripts calling the API: `PUT` and `POST` requests need an `X-Requested-With: fetch` header (a CSRF guard).
Besides `/api/config` (`PUT` takes a partial patch, e.g. `{"activeProfile": "taj_dubai"}`) and
`/api/config/reset` (optional `{"profile": "<id>"}`), the hotel has `GET`/`PUT /api/hotel/rooms`,
`POST /api/hotel/rooms/reset`, `GET /api/hotel/reservations?status=booked|cancelled|all` and
`POST /api/hotel/reservations/<confirmation number>/cancel`.

## Tests

```
npm test
```

Covers the resampler and chunker, the tools, the hotel bookings, the call lifecycle, persistence across
restarts, and runs the real server against a fake NeuraCX client (no Gemini key needed): auth, CSRF
header, call limit, frame size limit, clean shutdown on SIGTERM, use case switching and the hotel API.

## Not verified yet

- Conversations were tested against Gemini with typed caller turns, not real phone audio.
- The NeuraCX docs only show `exit` with a dial target. Plain hang-up sends `exit` with
  `"parameters": []`; check on a real call that NeuraCX drops the call cleanly.
- The docs describe how streaming works but not the portal screens for inbound numbers, so step 2 above
  may be named differently in your portal.
