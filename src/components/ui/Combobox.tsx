"use client";

import { useState } from "react";
import * as P from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import type { Option } from "./Select";

// A searchable select for long lists. Rendered in place, not portaled, so it scrolls inside a modal:
// the modal's scroll lock blocks wheel events on anything outside the modal's own DOM.
export function Combobox(props: { value: string; onChange: (v: string) => void; options: Option[]; labelledBy?: string; searchLabel: string }) {
  const [open, setOpen] = useState(false);
  const current = props.options.find((o) => o.value === props.value);
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger className="ui-trigger" aria-labelledby={props.labelledBy} role="combobox" aria-expanded={open}>
        <span>
          {current?.label ?? "Choose"}
          {current?.hint && <span className="ui-hint"> {current.hint}</span>}
        </span>
        <CaretDown size={14} className="ui-caret" />
      </P.Trigger>
        <P.Content className="ui-pop ui-combo" align="start" sideOffset={4}>
          <Command loop>
            <div className="ui-search">
              <MagnifyingGlass size={14} />
              <Command.Input placeholder={props.searchLabel} autoFocus />
            </div>
            <Command.List className="ui-list">
              <Command.Empty className="ui-empty">No match.</Command.Empty>
              {props.options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ""} ${o.value}`}
                  onSelect={() => {
                    props.onChange(o.value);
                    setOpen(false);
                  }}
                  className="ui-item"
                  data-state={o.value === props.value ? "checked" : undefined}
                >
                  <span>{o.label}</span>
                  {o.hint && <span className="ui-hint">{o.hint}</span>}
                  {o.value === props.value && (
                    <span className="ui-check">
                      <Check size={14} />
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </P.Content>
    </P.Root>
  );
}
