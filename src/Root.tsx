/**
 * FILE: src/Root.tsx
 * PURPOSE: Registers the compositions: Story per aspect, the long-form Vlog (16:9) and its thumbnail, photo posts,
 *          product videos (ProductPreview), and the Explainer (9:16) and its preview sheet.
 * OVERVIEW: Duration follows the clip list. Empty defaults so Studio can open.
 * DEPENDENCIES: remotion, ./Story, ./Vlog
 * USAGE: registerRoot(RemotionRoot) from index.ts
 * NOTES: 9:16, 4:5 and 16:9 are separate ids so a render cannot silently change shape. ProductPreview takes its size,
 *        fps and length from its preset (shared/product-presets.json via py/studio/product.py), and py/studio/product.py
 *        checks the rendered file against that preset.
 */
import { Composition } from "remotion";
import spec from "../shared/spec.json";
import { Story, storyFrames, type StoryProps } from "./Story";
import { Vlog, VlogThumb, vlogFrames, type ThumbProps, type VlogProps } from "./Vlog";
import { Post, emptyPost } from "./Post";
import { Explainer, ExplainerSheet, explainerFrames, sheetSize, type ExplainerProps, type SheetProps } from "./Explainer";
import { ProductPreview, emptyProduct } from "./ProductPreview";

const emptyStory: StoryProps = { shots9x16: [], shots16x9: [], beats: [], handle: "@cafe.kumo", bed: null };

const aspects = ["9x16", "4x5", "16x9"] as const;

const emptyVlog: VlogProps = { shots: [], chapters: [], title: "" };
const emptyThumb: ThumbProps = { src: "", title: "" };

export const RemotionRoot: React.FC = () => (
  <>
    {/* Long-form travel vlog for YouTube (py/studio/vlog.py): landscape only. */}
    <Composition id="Vlog-16x9" component={Vlog} fps={spec.fps} width={spec.formats["16x9"].w} height={spec.formats["16x9"].h}
      durationInFrames={spec.fps} defaultProps={emptyVlog} calculateMetadata={({ props }) => ({ durationInFrames: vlogFrames(props, spec.fps) })} />
    {/* Its thumbnail, in the same typefaces (a still). */}
    <Composition id="Vlog-Thumb" component={VlogThumb} fps={spec.fps} width={1280} height={720} durationInFrames={1} defaultProps={emptyThumb} />
    {/* An explainer from facts (py/studio/explainer.py): paper, hand-drawn lines, numbers with their source. */}
    <Composition id="Explainer-9x16" component={Explainer} fps={spec.fps} width={1080} height={1920} durationInFrames={spec.fps}
      defaultProps={{ scenes: [] } as ExplainerProps} calculateMetadata={({ props }) => ({ durationInFrames: explainerFrames(props, spec.fps) })} />
    {/* Its preview before a render: every scene's settled frame on one still (the console's Preview frames). */}
    <Composition id="Explainer-Sheet" component={ExplainerSheet} fps={spec.fps} width={1080} height={524} durationInFrames={1}
      defaultProps={{ scenes: [] } as SheetProps}
      // As long as the film (rendered as a still at frame 0): a frame frozen past the composition's end reads as its last.
      calculateMetadata={({ props }) => ({ ...sheetSize(props), durationInFrames: explainerFrames(props, spec.fps) })} />
    {/* Product videos from an app's release kit (py/studio/product.py, docs/product-kit.md): size from the preset. */}
    <Composition id="ProductPreview" component={ProductPreview} fps={emptyProduct.preset.fps} width={emptyProduct.preset.width} height={emptyProduct.preset.height}
      durationInFrames={emptyProduct.durationInFrames} defaultProps={emptyProduct}
      calculateMetadata={({ props }) => ({ width: props.preset.width, height: props.preset.height, fps: props.preset.fps, durationInFrames: Math.max(1, props.durationInFrames) })} />
    {/* Photo posts (py/studio/stills.py): every slide side by side as one still, cut into 1080 px slides afterwards. */}
    <Composition id="Post" component={Post} fps={spec.fps} width={emptyPost.w * emptyPost.panels} height={emptyPost.h} durationInFrames={1} defaultProps={emptyPost}
      calculateMetadata={({ props }) => ({ width: props.w * props.panels, height: props.h })} />
    {aspects.map((aspect) => {
      const size = spec.formats[aspect];
      return (
        <Composition
          key={`Story-${aspect}`}
          id={`Story-${aspect}`}
          component={Story}
          fps={spec.fps}
          width={size.w}
          height={size.h}
          durationInFrames={spec.fps}
          defaultProps={emptyStory}
          calculateMetadata={({ props }) => ({
            durationInFrames: storyFrames(props, spec.fps, aspect === "16x9"),
          })}
        />
      );
    })}
  </>
);
