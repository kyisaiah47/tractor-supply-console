"use client";

import * as S from "@radix-ui/react-select";
import { CaretDown, Check } from "@phosphor-icons/react";

export type Option = { value: string; label: string; hint?: string };

export function Select(props: { value: string; onChange: (v: string) => void; options: Option[]; labelledBy?: string; placeholder?: string }) {
  return (
    <S.Root value={props.value} onValueChange={props.onChange}>
      <S.Trigger className="ui-trigger" aria-labelledby={props.labelledBy}>
        <S.Value placeholder={props.placeholder} />
        <S.Icon className="ui-caret">
          <CaretDown size={14} />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content className="ui-pop ui-select" position="popper" sideOffset={4}>
          <S.Viewport className="ui-list">
            {props.options.map((o) => (
              <S.Item key={o.value} value={o.value} className="ui-item">
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint && <span className="ui-hint">{o.hint}</span>}
                <S.ItemIndicator className="ui-check">
                  <Check size={14} />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
