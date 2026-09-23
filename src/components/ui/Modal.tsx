"use client";

import * as D from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";

// The app's one modal. Radix handles focus, Escape and the scroll lock.
export function Modal(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  return (
    <D.Root open={props.open} onOpenChange={props.onOpenChange}>
      <D.Portal>
        <D.Overlay className="scrim" />
        <D.Content className="dialog" style={props.width ? { width: `min(${props.width}px, calc(100vw - 32px))` } : undefined}>
          <header>
            <D.Title>{props.title}</D.Title>
            {props.description ? <D.Description asChild><div className="dialog-desc">{props.description}</div></D.Description> : <D.Description className="sr-only">{props.title}</D.Description>}
            <D.Close className="btn ghost small dialog-x" aria-label="Close">
              <X size={14} />
            </D.Close>
          </header>
          {props.children && <div className="body">{props.children}</div>}
          {props.footer && <footer>{props.footer}</footer>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
