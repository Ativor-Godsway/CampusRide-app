/** react-native-svg as plain SVG elements (react-dom renders them). */
import { createElement, type ReactNode } from "react";

type Props = Record<string, unknown> & { children?: ReactNode };
const el = (tag: string) =>
  function SvgElement({ children, style: _style, ...props }: Props) {
    return createElement(tag, props, children);
  };

export default el("svg");
export const Svg = el("svg");
export const Circle = el("circle");
export const Path = el("path");
export const Rect = el("rect");
export const G = el("g");
export const Line = el("line");
export const Defs = el("defs");
export const LinearGradient = el("linearGradient");
export const Stop = el("stop");
