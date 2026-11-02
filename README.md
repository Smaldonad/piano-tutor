# Piano Tutor

A browser app for learning piano pieces from MIDI files, built for an iPad propped on the music stand.

I made this for myself, to learn a piece I wanted to play, and I'm sharing it in case someone else finds it useful. It is not maintained: I don't plan to update it, fix bugs or review issues and pull requests. Feel free to fork it and make it your own.

- Sheet music and falling notes side by side, in sync, with a keyboard showing what to press
- Chord names for every bar, with the next chord shown ahead of time
- Practice sections you can loop, slow down, and play hand by hand (play, mute or hide each hand)
- Section progress (learning / learned) and a daily practice log
- Notes per piece
- Two-finger double tap jumps back to the start of the loop
- With HTTPS set up (see below): works offline and keeps the iPad screen on while playing

There is a built-in demo, Bach's Prelude in C major (BWV 846, public domain, entered by hand), so you can try it without a MIDI file.

## Setting it up

You need a computer (Mac or Windows) to run the app, and you use it in a web browser: on that same computer, or on an iPad (or any tablet or phone) connected to the same Wi-Fi. The computer has to stay on while you practise.

### 1. Download it

Clone this repository or download the files (green **Code** button, then **Download ZIP**, and unzip it).

### 2. Start it

**On a Mac**

1. Open the folder and double-click **Start Piano Tutor.command**.
2. The first time, macOS may ask a few things:
   - *"cannot be opened" / "unidentified developer"*: open **System Settings → Privacy & Security**, scroll down, click **Open Anyway**, then double-click the file again.
   - *"install the command line developer tools"*: click **Install** and wait for it to finish (a few minutes). This installs Python, which the app needs. Then double-click the file again.
   - *"accept incoming network connections"*: click **Allow**. This is what lets the iPad reach it.
3. A Terminal window opens and shows the address to use. **Leave this window open** while you practise.

**On Windows**

1. Install Python from [python.org/downloads](https://www.python.org/downloads/). On the first screen of the installer, tick **Add python.exe to PATH**.
2. Open the folder and double-click **server.py**.
3. If Windows Firewall asks, allow access on **private networks**. This is what lets the iPad reach it.
4. A window opens and shows the address to use. **Leave this window open** while you practise.

### 3. Open it

- **On the same computer:** open a browser and go to `http://localhost:8000`
- **On an iPad:** make sure it is on the same Wi-Fi, open Safari and type the address shown in the window, for example `http://Your-Mac.local:8000`. If that doesn't load, use the one with numbers, like `http://192.168.1.20:8000`.
  To get an app icon, tap the **Share** button, then **Add to Home Screen**.

Tap **Try the demo** to see how it works.

### 4. Add your own pieces

You need a MIDI file (`.mid`) for each piece. Most sheet-music sites offer one to download next to the sheet music.

- Put `.mid` files in the `midi` folder inside the project folder. They show up under **Pieces → Library** on every device.
- Or, on the iPad, use **Pieces → Open a MIDI file** to pick one from the Files app.

### Every time after that

Double-click the same file again (step 2), then open the app on the iPad. To stop it, close the window.

### Good to know

- **Screen going to sleep:** the iPad will dim and lock while you play, unless HTTPS is set up (below). The easy fix: on the iPad, open **Settings → Display & Brightness → Auto-Lock** and pick **Never** while you practise.
- **The computer must be on** and running the app. Without HTTPS the app doesn't work offline.
- **Your notes and progress** are saved on the iPad and in the `notes` and `progress` folders on the computer.

### HTTPS (optional, technical)

Offline mode and keeping the screen awake need a secure (HTTPS) connection, which needs a certificate this project does not create for you. If `certs/server-chain.crt` and `certs/server.key` exist, the server also listens on HTTPS port 8443, and the `/setup` page walks through trusting the certificate on an iPad.

For developers: it is Python 3 standard library and plain JavaScript, with no build step or dependencies. Run `python3 server.py`.

## Security

The server is meant for a trusted home network. It has no login: anyone on the same Wi-Fi can open the app, see the files in `midi/`, and read or change the saved notes and progress. Don't run it on public or shared networks (cafés, hotels, offices), and stop it (close the window) when you're done.

## Credits

Music notation font: [Bravura](https://github.com/steinbergmedia/bravura), licensed under the SIL Open Font License (`fonts/OFL.txt`).

Piano sound: [Salamander Grand Piano V3](https://github.com/sfzinstruments/SalamanderGrandPiano) by Alexander Holm, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The recordings in `samples/` are trimmed and compressed with `tools/build_samples.py` (see `samples/README.md`).

## License

MIT, see `LICENSE`. The Bravura font (SIL Open Font License) and the piano samples (CC BY 3.0) keep their own licenses.
