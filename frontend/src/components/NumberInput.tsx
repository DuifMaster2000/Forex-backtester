import { useEffect, useState } from "react";

interface Props {
  value: number;
  onChange: (n: number) => void; // NaN while the box is blank
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}

// A controlled number input that allows an empty box while editing (instead of
// snapping to 0). It reports NaN when blank; callers validate on launch.
export default function NumberInput({ value, onChange, ...rest }: Props) {
  const [text, setText] = useState(fmt(value));

  // Re-sync from the prop only when the value is changed externally (e.g. a
  // defaults reset) — not while the user's in-progress text already matches it.
  useEffect(() => {
    const parsed = text === "" ? NaN : Number(text);
    const same = (Number.isNaN(parsed) && Number.isNaN(value)) || parsed === value;
    if (!same) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="number"
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        onChange(t === "" ? NaN : Number(t));
      }}
      {...rest}
    />
  );
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(v) : "";
}
