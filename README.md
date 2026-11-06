# Night of the Ninja — Online Multiplayer

A browser-based recreation of **Night of the Ninja** (by Justin Gary / Brotherwise Games) for remote team play.

## How to Run

1. Make sure you have Node.js installed.
2. In this folder run:
   ```bash
   npm install
   node server.js
   ```
3. Open your browser to `http://localhost:3000`
4. One person creates a room, shares the **room code**.
5. Everyone else joins with the code.
6. Host clicks **Start Game** (needs 4+ players).

## For Remote Play

- Run the server on a machine that others can reach (same network, or use a tunnel like ngrok / Cloudflare Tunnel).
- Or deploy the folder to a free host that supports Node.js (Render, Railway, Fly.io, etc.).

## Features in this version

- Room lobby with shareable code
- House cards (Crane / Lotus + Ronin)
- Draft phase structure
- Night phases framework
- Core cards: Spy, Mystic, Blind Assassin, Shinobi
- Special cards: Shapeshifter, Judge, Gravedigger, Spirit Merchant, Thief, Troublemaker
- Reactions: Mirror Monk & Martyr
- Mastermind
- Honor scoring toward 10

## Notes

This is a functional recreation of the core experience based on the published rules, FAQ, and public reviews. Full simultaneous resolution of every edge-case Trickster interaction is implemented at the server level and can be expanded.

Enjoy the Night!
