import type { ImgHTMLAttributes } from "react";

import mark from "../../../../assets/arcwright/mark-on-light.png";
import wordmark from "../../../../assets/arcwright/wordmark-on-light.png";
import wordmarkOnDark from "../../../../assets/arcwright/wordmark-on-dark.png";
import { cn } from "../lib/utils";

export function ArcwrightMark({ className, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img
      alt="Arcwright Code"
      {...props}
      src={mark}
      className={cn("arcwright-mark object-contain", className)}
    />
  );
}

export function ArcwrightWordmark({
  className,
  onDark = false,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { readonly onDark?: boolean }) {
  return (
    <img
      alt="Arcwright Code"
      {...props}
      src={onDark ? wordmarkOnDark : wordmark}
      className={cn("arcwright-wordmark object-contain", className)}
    />
  );
}
