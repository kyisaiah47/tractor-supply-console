"use client";

import { useState } from "react";
import * as P from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { CalendarBlank } from "@phosphor-icons/react";
import { day } from "@/lib/format";

const toDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const toStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// value and min are 'YYYY-MM-DD'. Days on or before `after` are disabled.
export function DatePicker(props: { value: string; onChange: (v: string) => void; after: string; labelledBy?: string }) {
  const [open, setOpen] = useState(false);
  const selected = toDate(props.value);
  const first = toDate(props.after);
  first.setDate(first.getDate() + 1);
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger className="ui-trigger" aria-labelledby={props.labelledBy}>
        <span className="mono">{day(props.value)}</span>
        <CalendarBlank size={16} className="ui-caret" />
      </P.Trigger>
        <P.Content className="ui-pop ui-calendar" align="start" sideOffset={4}>
          <DayPicker
            mode="single"
            required
            selected={selected}
            defaultMonth={selected}
            startMonth={first}
            disabled={{ before: first }}
            onSelect={(d) => {
              if (d) {
                props.onChange(toStr(d));
                setOpen(false);
              }
            }}
          />
        </P.Content>
    </P.Root>
  );
}
