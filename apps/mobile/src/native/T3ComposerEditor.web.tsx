import { useEffect, useImperativeHandle, useRef } from "react";
import { TextInput, View, type TextInput as RNTextInput, type View as RNView } from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { useFontFamily } from "../lib/useFontFamily";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { ComposerEditorProps } from "./T3ComposerEditor.types";

function clipboardImageFiles(clipboardData: DataTransfer): File[] {
  const candidates = Array.from(clipboardData.files).length
    ? Array.from(clipboardData.files)
    : Array.from(clipboardData.items).flatMap((item) => {
        if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
        const file = item.getAsFile();
        return file ? [file] : [];
      });
  return candidates.filter((file) => file.type.startsWith("image/"));
}

async function imageFilesToDataUrls(images: File[]): Promise<string[]> {
  return Promise.all(
    images.map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error("Unable to read pasted image."));
          reader.onload = () =>
            typeof reader.result === "string" ? resolve(reader.result) : reject();
          reader.readAsDataURL(file);
        }),
    ),
  );
}

export function ComposerEditor({
  ref,
  skills: _skills,
  selection,
  onPasteImages,
  style,
  textStyle,
  contentInsetVertical = 0,
  singleLineCentered: _singleLineCentered,
  ...props
}: ComposerEditorProps) {
  const inputRef = useRef<RNTextInput>(null);
  const wrapperRef = useRef<RNView>(null);
  const bodyText = useScaledTextRole("body");
  const foregroundColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-placeholder");
  const fontFamily = useFontFamily("regular");

  useEffect(() => {
    const element = wrapperRef.current as unknown as HTMLElement | null;
    if (!element || !onPasteImages) return;
    const onPaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      const images = clipboardImageFiles(event.clipboardData);
      if (images.length === 0) return;
      // This must happen during dispatch. Calling it after FileReader resolves
      // is too late for Chromium to suppress its default image paste behavior.
      event.preventDefault();
      void imageFilesToDataUrls(images).then((uris) => {
        onPasteImages(uris);
      });
    };
    element.addEventListener("paste", onPaste);
    return () => element.removeEventListener("paste", onPaste);
  }, [onPasteImages]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      setSelection: (nextSelection) =>
        inputRef.current?.setSelection(nextSelection.start, nextSelection.end),
    }),
    [],
  );

  return (
    <View ref={wrapperRef} style={[{ minHeight: 0 }, style]}>
      <TextInput
        ref={inputRef}
        {...props}
        selection={selection}
        onSelectionChange={(event) => props.onSelectionChange?.(event.nativeEvent.selection)}
        multiline={props.multiline ?? true}
        placeholderTextColor={placeholderColor}
        style={[
          {
            flex: 1,
            minHeight: 0,
            color: foregroundColor,
            fontFamily,
            ...bodyText,
            paddingVertical: contentInsetVertical,
          },
          textStyle,
        ]}
      />
    </View>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
