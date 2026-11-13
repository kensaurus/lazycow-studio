/**
 * FILE: src/index.ts
 * PURPOSE: Remotion registerRoot entry.
 * OVERVIEW: Points the CLI at RemotionRoot.
 * DEPENDENCIES: remotion, ./Root
 * USAGE: remotion studio src/index.ts
 * NOTES: none
 */
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
