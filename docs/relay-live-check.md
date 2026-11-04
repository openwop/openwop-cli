# Relay live check (scripted, manual)

The relay's automated tests run against fixtures (`test/fixtures/relay/`). This is
the scripted check a person runs against real accounts before calling a channel
production ready (openwop-app ADR 1043 D8). It is **not** run by CI or by agents:
it links a real account and sends real messages.

Run it only with **your own** accounts on **your own** machine (ADR 1041 D2), and
against a server you control or a staging workspace. Never use a number the operator
or an employer owns. For WhatsApp, use a spare number you can afford to have banned.

Record each run (date, CLI version, server commit, pass/fail per step) in the PR or
release notes that ships the change.

## 0. Common setup

```bash
export OPENWOP_BASE_URL=https://<your-server>/api   # never a link; typed by you
openwop login                                        # a signed-in person, so the relay has an owner
openwop relay devices --json                         # baseline
```

On the server, with `channel-ingress` on for the test workspace: create a messaging
connector for the channel, set its policy, and allowlist the test contact
(`openwop messaging connectors add …`, `openwop messaging allowlist add …`).

For each channel below, the same ten steps apply. Expected results are in brackets.

1. `openwop relay setup --channel <ch> --account <your own id>` in a terminal.
   [The risk notice prints; anything but `yes` cancels with nothing registered;
   `yes` registers and activates; `openwop relay status` says online.]
2. `openwop relay start` in the foreground. [Link prompt or session reuse; "Inbound
   receive active".]
3. From the test contact, send `ping`. [The relay logs `← … ping`; a conversation
   appears in your main chat; the contact sees "typing" (not iMessage); the agent's
   reply arrives in the contact's chat; typing stops.]
4. From the contact, send three messages within a second. [One turn, with the three
   texts joined.]
5. In your note-to-self chat, send `what is on my calendar?`. [It runs as you (full
   lane). The reply lands in the same chat once and does NOT loop.]
6. Write to the contact from your own phone. [Nothing is forwarded.]
7. Ask the agent for a reply with two attachments (an image and a PDF), or queue one:
   `openwop relay send --conversation <contact> --text files` with media through the
   API. [Both arrive, the caption on the first.]
8. Turn networking off for two minutes, then on. [The relay logs backoff retries and
   recovers; `openwop relay devices` showed `offline` meanwhile and `online` after.]
9. `openwop relay rotate`, then restart the relay. [It keeps working with the new
   token; the old token is refused after 10 minutes.]
10. `openwop relay revoke`. [The running relay stops with "This relay was revoked",
    exit 0, and a service does not restart it.]

Then re-capture the platform fixtures (they were written in each library's payload
shape, not captured live): copy one raw event per kind from the platform tool's own
debug output
(Baileys `messages.upsert` with `logger: pino({level:'debug'})`, `signal-cli -o json
receive`, `sqlite3 -json chat.db` with the relay's query) into
`test/fixtures/relay/`, replacing numbers with 555 fakes. Re-run `npm test`.

## Per channel

### WhatsApp (Baileys)

- Prerequisite: `npm i -g @whiskeysockets/baileys`; a spare number.
- Step 2 prints a QR code once; scan it from WhatsApp → Linked devices.
- Extra: remove the linked device from the phone while the relay runs. [The relay
  stops with "WhatsApp logged this device out", exit 0, and does not reprint a QR.]
- Extra: kill the network for 30 s. [It reconnects without a new QR.]

### Signal (signal-cli)

- Prerequisite: `signal-cli link -n openwop-relay` scanned from the phone, then
  `signal-cli -a <number> daemon --http 127.0.0.1:8080` and
  `OPENWOP_SIGNAL_DAEMON_URL=http://127.0.0.1:8080 OPENWOP_SIGNAL_ACCOUNT=<number>`.
- Step 5 uses Signal's "Note to Self".
- Extra: stop the daemon for a minute. [The relay backs off and reconnects.]

### iMessage (macOS)

- Prerequisite: Messages signed in; Full Disk Access for the terminal (or the node
  binary the service runs).
- Step 3 shows no typing indicator (none exists).
- Step 5: message your own handle. [Only one turn per note: the mirrored received
  copy is dropped.]
- Extra: start the relay with a long chat history. [No history is replayed; only new
  messages are forwarded.]

### Service install (macOS and Linux)

1. `openwop relay service install --dry-run`, read the file. [No token in it.]
2. `openwop relay service install`; `openwop relay service status`. [Running.]
3. Kill the relay process. [launchd/systemd restarts it within ~30 s.]
4. `openwop relay revoke`. [The service stops and stays stopped.]
5. `openwop relay service uninstall`. [The file is gone.]
