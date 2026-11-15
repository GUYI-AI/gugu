import type { ElementBox as Box } from '@/lib/elementVisibility';

type Radii = Pick<CSSStyleDeclaration, 'borderTopLeftRadius' | 'borderTopRightRadius' | 'borderBottomRightRadius' | 'borderBottomLeftRadius'>;

/**
 * The corners an App's page is drawn with: the rounded corners of the place it is put in (the claiming slot's own
 * `border-radius`, e.g. the assistant panel's card), so a page drawn in the root layer is clipped as that place clips its
 * content. Only where the place's corner is on screen: a corner cut off by an ancestor's clip (`clip` short of `full` on
 * that side) is square, since what shows there is the middle of the page.
 */
export function pageCorners(radii: Radii, full: Box, clip: Box): Radii {
  const left = clip.left === full.left;
  const top = clip.top === full.top;
  const right = clip.left + clip.width === full.left + full.width;
  const bottom = clip.top + clip.height === full.top + full.height;
  const at = (kept: boolean, radius: string) => (kept && radius ? radius : '0px');
  return {
    borderTopLeftRadius: at(top && left, radii.borderTopLeftRadius),
    borderTopRightRadius: at(top && right, radii.borderTopRightRadius),
    borderBottomRightRadius: at(bottom && right, radii.borderBottomRightRadius),
    borderBottomLeftRadius: at(bottom && left, radii.borderBottomLeftRadius),
  };
}
