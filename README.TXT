=====================================================================

     L  A  Z  Y  C  O  W      S  T  U  D  I  O

     Your footage. Your PC. You just say yes.
     (c) kensaurus LLC  -  Free and open source (Apache-2.0)

=====================================================================

  >>> PLEASE READ THIS FILE BEFORE INSTALLING. <<<
  (Yes, really. It is 1997 in here. Pour a coffee. Insert Disk 1.)


---------------------------------------------------------------------
  WHAT IS ON THIS "CD"
---------------------------------------------------------------------

  Lazycow Studio turns the photos and videos already on your
  computer into short vertical videos (Reels, Shorts, TikToks) and
  long trip videos for YouTube. It picks the best clips, adds words
  you approved and free music, and helps you post them.

  You only review. Lazy Kenji (our mascot, on the cow-print bean
  bag) does the rest. Everything stays on your computer.


---------------------------------------------------------------------
  MINIMUM SYSTEM REQUIREMENTS
---------------------------------------------------------------------

  [x] Windows 10 or 11, 64-bit           (or a Mac with Apple
                                           silicon, macOS 14+)
  [x] 8 GB of memory (16 GB is happier)
  [x] 20 GB of free disk space
  [x] An internet connection for the first setup (about 1.5 GB)
  [x] Google Chrome or Microsoft Edge
  [ ] A floppy drive                     (NOT required. Phew.)
  [ ] A serial number                    (NOT required. See STEP 7.)


---------------------------------------------------------------------
  INSTALLATION
---------------------------------------------------------------------

  STEP 1.  Unzip this whole folder somewhere you will keep it,
           for example  Documents\Lazycow Studio .
           (Right-click the .zip > "Extract All...". Do not run it
           from inside the zip; it gets confused, like we all do.)

  STEP 2.  Double-click   Start Lazycow
           (On a Mac: right-click "Start Lazycow.command" > Open,
           only the first time.)

  STEP 3.  Windows may say "Windows protected your PC".
           Click  "More info"  then  "Run anyway".
           That only means the file came from the internet and
           is new. It is our installer; you can read every line
           of it in  scripts\bootstrap\windows.ps1 .

  STEP 4.  A BLUE SETUP SCREEN appears. Very 1997. Very good.
           It asks two questions (press Enter to accept the
           suggestion):
             - where the studio keeps what it makes
             - where your photos and videos are
           It also asks if it may download ffmpeg (the video
           engine). Say Y unless you already have one.

  STEP 5.  Wait 10 to 30 minutes while it downloads Node, Python
           and the studio's parts. Every file is checked against
           its fingerprint (SHA-256) before it is used. Nothing is
           installed for the whole computer and no admin password
           is needed.

  STEP 6.  The studio opens in its own window. Lazy Kenji walks
           you through the rest: pick your footage, make your
           first reels, say yes to the good ones.

  STEP 7.  There is no step 7. No serial number. No CD key.
           No crack. It is free. Really.
           (If you love it, see SUPPORTING.md. That is optional.)


---------------------------------------------------------------------
  NEXT TIME
---------------------------------------------------------------------

  Double-click  "Lazycow Studio"  on your desktop (or in the Start
  menu). That is it.


---------------------------------------------------------------------
  TROUBLESHOOTING  (a.k.a. "It does not work!!1")
---------------------------------------------------------------------

  * Something went wrong during setup?
    Double-click Start Lazycow again. It carries on where it
    stopped. The full story is in
        %LOCALAPPDATA%\Lazycow\setup.log
    (Mac: ~/Library/Application Support/Lazycow/setup.log)

  * The studio says something is wrong?
    Look for the red (or amber) warning button at the top, next to
    the bell. Red means something will NOT happen (a post, a
    render) until you fix it; there is always a Fix button, and it
    stays until it is fixed. Amber means it works, but not as well
    as it could. Lazy Kenji looks worried while anything is red.

  * Your antivirus complains?
    It is reacting to a script that downloads programs. That is
    what an installer does. Every download is pinned and
    fingerprint-checked; see scripts\bootstrap\versions.json.

  * Still stuck? Ask on GitHub (Issues or Discussions). Bring
    setup.log. Lazy Kenji will wake up. Eventually.


---------------------------------------------------------------------
  FOR DEVELOPERS
---------------------------------------------------------------------

  Prefer a terminal? git clone, npm ci, npm run setup, npm run
  review. See README.md. You know the drill.


---------------------------------------------------------------------
  LEGAL STUFF (we kept it short)
---------------------------------------------------------------------

  Code: Apache License 2.0 (LICENSE). The names "Lazycow" and
  "Lazycow Studio" and the icon are trademarks (TRADEMARKS.md).
  ffmpeg is GPL; its licence goes in your data folder's bin.
  Remotion is free for individuals and teams of up to 3; bigger
  companies need a Remotion licence. Details: THIRD_PARTY_NOTICES.md


=====================================================================
   日本語
=====================================================================

  インストールの前に、このファイルを読んでください（1997年ふう）。

  ステップ1  このフォルダを、置いておく場所に丸ごと展開します。
             （zip を右クリック >「すべて展開」）
  ステップ2  「Start Lazycow」をダブルクリック。
  ステップ3  「WindowsによってPCが保護されました」と出たら、
             「詳細情報」>「実行」。インターネットから来た新しい
             ファイルだという意味です。
  ステップ4  青いセットアップ画面で、保存先とあなたの写真・動画の
             場所を答えます（Enter でおすすめのまま）。
             ffmpeg（動画エンジン）のダウンロードは Y で。
  ステップ5  10〜30分待ちます。ファイルはすべて指紋（SHA-256）を
             確認してから使います。管理者のパスワードは不要です。
  ステップ6  スタジオが開きます。あとはケンジが案内します。
  ステップ7  ステップ7はありません。シリアル番号もクラックも不要。
             無料です。ほんとうに。

  次からは、デスクトップの「Lazycow Studio」をダブルクリック。
  困ったら、もう一度「Start Lazycow」を。続きから再開します。

=====================================================================
  Thank you for choosing Lazycow Studio. Now go make something.
=====================================================================
