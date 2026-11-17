# Security

Lazycow Studio runs on your own computer. It holds keys to your social accounts and your AI providers, so a security bug here can mean someone posts as you or spends your money. Please tell us privately.

## Report a problem

- **Use GitHub's private report:** the repository's **Security** tab › **Report a vulnerability**. Only the maintainers see it.
- **Do not** open a public issue, pull request or discussion for it.
- Say what an attacker can do, the steps, and the version (`package.json` "version", or the footer of the studio).

We answer within 7 days, agree a fix date with you, and credit you in the CHANGELOG unless you ask us not to.

## What counts

- Anything that lets another program, web page or person on your network act on the studio without your token: post, approve, read keys, read footage outside your folders.
- A reel posted without a person's approval. The studio must never do that.
- A key, token or sign-in leaving your computer anywhere other than the provider it belongs to, or being written to a log.
- The Wi-Fi drop box (`server/dropbox.mjs`) accepting files from outside your private network, or writing outside its folder.

## What does not

- Problems that need someone who already controls your computer or your user account.
- The studio being reachable on `127.0.0.1` by programs you run yourself (set `STUDIO_API_TOKEN` on a shared computer).
- Bugs in Remotion, FFmpeg, Python packages or a social network's own site: report those upstream.

## Supported versions

Only the latest release gets fixes.

## How the studio protects you

- It listens on `127.0.0.1` only. With `STUDIO_API_TOKEN` set, every call needs the token.
- Keys live in `.env` or in `STUDIO_DATA\secrets`, never in git. On Windows, sign-ins are encrypted for your user (DPAPI).
- Paid AI calls are priced first and refused over your limits.
- Only reels a person approved can be booked or posted.
