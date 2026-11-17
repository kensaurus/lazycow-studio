# Filming guide

How to film footage that Lazycow Studio cuts well. Most of this follows from how the studio picks and cuts clips ([how it picks which moments to use](architecture.md#how-it-picks-which-moments-to-use)). Each tip says why, with the code behind it. Tips marked **(general practice)** are ordinary camera advice the studio does not check.

[日本語](filming-guide.ja.md)

## The short version

- **Film many short takes, 5 to 15 seconds each, one subject per take.** Stop recording between subjects.
- **Hold still for a second at the start and the end** of each take.
- **Landscape at 4K, or vertical at 1080p or more, at 30 fps.** SDR rather than HDR, if your phone lets you choose.
- **Keep location on** in the camera or phone.
- **Film scenery without people**, or ask the people on camera first.
- **Mostly video.** Photos are welcome, but a reel uses at most 30 % photos.

## Clip length: 5 to 15 seconds, never long recordings

How the studio cuts a reel:
- A reel is 8 to 25 seconds long.
- Each shot is 1 to 4 seconds, and every cut sits on a half-second grid that follows the music's beat (`check_reel` in `py/studio/reels.py`, `fit_cuts` in `py/studio/sound.py`).
- A reel never uses the same file twice.

What that means for your takes:

| Why | From the code |
|:--|:--|
| **One file gives one shot per reel.** Twenty short takes can fill twenty slots; one long recording fills one. | `check_reel`: "a source file is used twice" stops the render. |
| **Search sees three frames of each file**, at 15 %, 50 % and 85 % of its length, blended into one description. A 15-second take is described by what it shows. A 20-minute file is a blur of three moments 7 minutes apart. | `library._keyframes`, `library._clip` |
| **A take must be a little longer than the shot.** A clip is only picked when it is at least the shot's length plus 0.8 s, and its first and last 0.3 s are never used. For a 4-second shot that means about 5 seconds of footage. | `assemble.py`, `pick.best_window` |
| **Over 40 seconds, the start and end are thrown away.** The first 10 % and last 15 % of a long file are never used (they are treated as a drone's take-off and landing), and the window is chosen from keyframes only. | `pick.best_window` |
| **Long files are slow.** Picking from a long 4K file decodes nearly all of it; the preview in the editor re-encodes all of it. | `pick.picture_fit`, `proxyFor` in `server/review.mjs` |
| **One use marks the whole file down.** Each reel that uses a file lowers it in later searches, including the moments no reel has shown yet. | `assemble.rank`: −0.06 per reel |

So: **5 to 15 seconds a take, one subject or one move per take, and keep takes under 40 seconds.** Ten short takes of the same place from different angles give the studio ten choices. A 2-second take is too short for most shots.

## Inside a take

- **Hold still for about a second before and after a move.** The first and last 0.3 s are never used. The picker prefers a window that is sharp and has some movement, so a steady start, a slow move and a steady end gives it good windows (`best_window`: sharpness plus 0.6 × motion).
- **One slow, steady move per take:** a slow pan, a walk forward, a tilt up. Fast whips and shaky bursts are marked down in long files. A handheld clip that measures shaky (`SHAKE_AUTO` 0.20) is steadied automatically if your ffmpeg has vidstab (`py/studio/shot.py`). Steadying crops a little; a steady take is still better.
- **No zoom.** The studio already crops landscape footage to 9:16, and digital zoom throws away more of the picture (general practice).
- **Avoid nearly black or blown-out frames.** Windows whose brightness is under 6 % or over 96 % are marked down (`best_window`).
- **Point the camera at something.** Close-ups of the ground, weeds, a hand, paper or a screen score as filler and are never auto-picked (`JUNK_PROMPTS` in `library.py`, `JUNK_MAX` 0.4).

## Orientation and framing

The studio renders three sizes from every reel: **9:16 at 1080×1920, 4:5 at 1080×1350 and 16:9 at 1920×1080**, all at 30 fps (`shared/spec.json`, `shared/channels.json`).

| You film | 9:16 and 4:5 | 16:9 |
|:--|:--|:--|
| **Landscape (16:9)** | Cropped to a full-height window that follows a face, else the sharpest area (`shot.measure`, `crop_for`) | The whole picture |
| **Vertical (9:16)** | The whole picture (4:5 crops the top and bottom) | Your picture in the middle, with a blurred copy of itself behind |

- **Reels only:** either works. **Reels and long YouTube videos:** film landscape.
- **In landscape, keep one clear subject.** The 9:16 window is a third of the frame's width and moves to the subject. Two subjects at opposite edges cannot both be in it.
- **Leave some calm space**, such as sky, a wall or grass. On-screen words go on the quieter side of each shot (`reels.place_words`). In 9:16 the text area is the upper two-thirds of the frame; the bottom third is kept clear for the app's buttons (`safe` in `shared/spec.json`).

## Resolution, frame rate, HDR

- **Resolution.** In a 9:16 crop from **4K landscape**, the window is 1215 px wide, so it fills 1080 px with detail to spare. From **1080p landscape**, the window is only 607 px wide and is enlarged about 1.8 times, which looks soft. Film landscape at **4K**. Vertical at 1080p or more is fine.
- **Frame rate: 30 fps.** Every shot is rendered at 30 fps (`fps=30` in `shot.py`). 60 fps also works: frames are dropped, and motion looks a little crisper. The studio does not slow 60 fps footage down by itself. Its AI slow motion only takes clips of 31 fps or less (`py/studio/ai.py`). 24 or 25 fps footage is converted to 30, which can judder on pans (general practice).
- **HDR.** HDR video (HLG or PQ, an iPhone's default "HDR Video") is tone-mapped to normal SDR before grading (`TONEMAP` in `py/studio/formats.py`). It works, but colours and contrast can differ from what your phone showed. For predictable colour, turn HDR video off: on iPhone, Settings › Camera › Record Video › HDR Video. On Android it is usually in the camera app's video settings (general practice).

## Light and colour

- **Lock exposure and focus** on a phone (press and hold on the subject) so brightness does not pump during the take (general practice).
- **Keep white balance steady across a scene.** The studio grades each shot from its own measured levels. By default it also pulls each shot's colour cast half way toward the reel's middle, changing no channel by more than 8 % (`colorMatch`, `color_correction` in `shot.py`). It cannot fix a scene that jumps from warm to blue (general practice).
- **Golden hour and blue hour.** The hour after sunrise and before sunset, and the half hour after sunset, give soft, warm light and deep skies (general practice). Dark frames still count: night is detected from darkness (`library.py`).
- **Clean the lens** before each session. A smudge gives a soft, hazy picture the sharpness score cannot fix (general practice).

## Sound

- **The clip's own sound is used.** Every reel has a version with the clips' own sound, and the music version ducks the music under it (`sound.mix`). Picking never listens, so a windy take can be chosen.
- **Wind.** Use a wind cover on the microphone, or film from behind a wall or a car in wind (general practice). Long videos measure wind and turn windy clips down (`quality.py`). Reels do not.
- **Silence is fine.** A silent shot can get AI-made natural sound if you add a fal.ai key ([AI tools](ai-api.md)).

## Location and time

- **Keep location (GPS) on.** A project can have a home place (Settings › Keys & AI › This project). Only footage placed there is picked for reels, and the render refuses footage that is not (`off_site` in `reels.py`). The studio places a file by its own GPS, then by the GPS of other files in its folder, then in its event folder, then by the folder's name (`library.place_from`). A file with no GPS in a folder with no GPS counts as "unknown" and is not auto-picked.
- **No GPS?** When you add the folder (Footage › Add a folder), choose **Shot here** (the "trusted" mode). That vouches that everything in it was shot at the home place (`sources.add(path, "trusted")`). A project with no home place uses every clip.
- **Set the camera's clock right.** The capture month sets the season tags, and the date ties a file to its trip (`media.captured_from_name`, `library.event_of`).

## People and consent

- **Reels made by themselves skip people.** Clips with a detected face, or that CLIP scores as showing a person (people seen from behind or hands included), are left out unless the theme allows faces (`PERSON_MAX` 0.35 in `library.py`, `noFaces` in `assemble.py`). Scenery, places, food and things are what get picked.
- **A reel with a face cannot be approved** until someone ticks Consent OK, or the reel is rendered with **Blur faces** (`py/studio/review_actions.py`). Ask people before you film them.
- Face detection needs the YuNet model file; see [Run it fully local](architecture.md#run-it-fully-local).

## Photos, drone, 360

- **Photos:** at most 30 % of a reel's shots, each held 2 seconds at most (`check_reel`). Reels the studio makes by itself always open on a video (`assemble.py`). HEIC, AVIF, DNG and camera RAW are read (`shot.open_photo`).
- **Drone:** DJI files are recognised by device or by a `DJI_` file name and are never steadied (`shot.is_drone`). A theme can ask for drone footage only. Stop and start the recording between moves rather than flying one long take: the first 10 % and last 15 % of any file over 40 s are skipped.
- **360:** Insta360 and 2:1 equirectangular files are recognised. They are reframed with a moving virtual camera instead of being cropped (`py/studio/sphere.py`).

## Folders and names

- **A dated folder per outing,** such as `2026\20261123_winter-open\` inside your footage folder. The date in the name dates the event, and the folder groups its files for location (`library.event_of`).
- **Keep finished edits out of footage folders.** Files named with `_reel_`, `_9x16`, `_4x5` or `_16x9`, and folders called `ready` or `drafts`, are treated as finished edits and never used as footage (`ingest.is_output`).
- **Keep the original files.** If the same clip is in a Google Photos import and in your folder, the original is preferred (`library.prefer_originals`).

## Checklist

| Before | While filming | After |
|:--|:--|:--|
| Lens clean | 5-15 s per take, one subject per take | Copy into a dated folder in your footage folder |
| Location on | 1 s still at the start and the end | Keep exported edits out of that folder |
| Clock right | One slow, steady move; no zoom | Let the studio tag it (it checks your folders every 30 minutes) |
| 4K landscape, or vertical ≥1080p | Exposure and focus locked | Ask anyone on camera for consent, or plan to blur |
| 30 fps, HDR video off | Calm space for words; one clear subject | Click a clip you never want used, then **Never auto-pick** |
| Wind cover on | Mostly video, a few photos | |
