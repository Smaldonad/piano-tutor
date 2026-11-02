# Piano Tutor

A browser app for learning piano pieces from MIDI files, built for an iPad propped on the music stand.

I made this for myself, to learn a piece I wanted to play, and I'm sharing it in case someone else finds it useful. It is not maintained: I don't plan to update it, fix bugs or review issues and pull requests. Feel free to fork it and make it your own. Most of the code was written by Claude Code.

- Sheet music and falling notes side by side, in sync, with a keyboard showing what to press
- Chord names for every bar, with the next chord shown ahead of time
- Practice sections you can loop, slow down, and play hand by hand (play, mute or hide each hand)
- Section progress (learning / learned) and a daily practice log
- Notes per piece
- Works offline once installed to the Home Screen
- Two-finger double tap jumps back to the start of the loop; the screen stays on while playing

There is a built-in demo, Bach's Prelude in C major (BWV 846, public domain, entered by hand), so you can try it without a MIDI file.

## Running it

Needs Python 3, nothing else (no build step, no dependencies).

```
python3 server.py
```

Then open the printed address on any device on the same Wi-Fi, or `http://localhost:8000` on the same computer. On a Mac you can double-click `Start Piano Tutor.command` instead.

Put `.mid` files in a `midi/` folder next to `server.py` to see them in the library, or open a file from the device.

Notes and progress are saved on the device and, when the server is reachable, in `notes/` and `progress/`.

### HTTPS (optional)

Keeping the screen awake and offline mode need a secure connection. If `certs/server-chain.crt` and `certs/server.key` exist, the server also listens on https port 8443, and `/setup` walks through trusting the certificate on an iPad. Without them everything else works over plain http.

## Security

The server is meant for a trusted home network. It has no login: anyone on the same Wi-Fi can open the app, see the files in `midi/`, and read or change the saved notes and progress. Don't run it on public or shared networks (cafés, hotels, offices), and stop it with Ctrl+C when you're done.

## Credits

Music notation font: [Bravura](https://github.com/steinbergmedia/bravura), licensed under the SIL Open Font License (`fonts/OFL.txt`).
