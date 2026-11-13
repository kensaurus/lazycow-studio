/**
 * FILE: remotion.config.ts
 * PURPOSE: Remotion entry config for the local reel studio.
 * OVERVIEW: Design-layer renders only. Pixels are pre-graded mezzanines.
 * DEPENDENCIES: @remotion/cli
 * USAGE: npx remotion studio / npx remotion render
 * NOTES: webpack caching stays on so repeat renders of the three reels are cheaper.
 */
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
