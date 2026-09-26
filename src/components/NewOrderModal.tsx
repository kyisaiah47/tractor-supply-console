"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusCircle } from "@phosphor-icons/react";
import { TRACTOR_MODELS, WAREHOUSES } from "@/lib/catalog";
import { day } from "@/lib/format";
import { addDays } from "@/lib/dates";
import { newIdempotencyKey } from "@/lib/idempotency";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";
import { Combobox } from "./ui/Combobox";
import { DatePicker } from "./ui/DatePicker";

const OWN_STATE = "own";
type Customer = { id: number; name: string; state: string };

export function NewOrderModal(props: { open: boolean; onOpenChange: (v: boolean) => void; asOf: string }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [model, setModel] = useState<string>(TRACTOR_MODELS[0].code);
  const [quantity, setQuantity] = useState(2);
  const [warehouse, setWarehouse] = useState(OWN_STATE);
  const [requested, setRequested] = useState(() => addDays(props.asOf, 60));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const router = useRouter();
  // One key per order being entered. A retry after an error reuses it; a recorded order starts a new one.
  const orderKey = useRef(newIdempotencyKey());

  useEffect(() => {
    if (!props.open || customers.length) return;
    fetch("/api/customers")
      .then((r) => r.json())
      .then((b: { customers: Customer[] }) => {
        setCustomers(b.customers);
        setCustomerId((cur) => cur || String(b.customers[0]?.id ?? ""));
      });
  }, [props.open, customers.length]);

  const customer = customers.find((c) => String(c.id) === customerId);

  function close(v: boolean) {
    props.onOpenChange(v);
    if (!v) {
      setSaved(null);
      setError(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": orderKey.current },
      body: JSON.stringify({
        customerId: Number(customerId),
        tractorModel: model,
        quantity,
        warehouse: warehouse === OWN_STATE ? undefined : warehouse,
        requestedDate: requested,
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof body.error === "string" ? body.error : "Check the fields and try again.");
      return;
    }
    orderKey.current = newIdempotencyKey();
    setSaved(body.id);
    window.dispatchEvent(new Event("orders-changed"));
    router.refresh();
  }

  return (
    <Modal
      open={props.open}
      onOpenChange={close}
      width={560}
      title={saved ? "Order recorded" : "New customer order"}
      description={
        saved
          ? `Order #${saved} for ${quantity} ${model} is in the backlog for ${day(requested)}.`
          : "The order joins the backlog now. The next forecast update counts it as booked demand."
      }
      footer={
        saved ? (
          <>
            <button className="btn" onClick={() => setSaved(null)}>
              Record another
            </button>
            <button className="btn primary" onClick={() => close(false)}>
              Done
            </button>
          </>
        ) : (
          <>
            {error && (
              <span className="ink-short" style={{ marginRight: "auto", alignSelf: "center", fontSize: 13 }}>
                {error}
              </span>
            )}
            <button className="btn" onClick={() => close(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={submit} disabled={busy || !customerId}>
              <PlusCircle size={16} />
              {busy ? "Saving" : "Record order"}
            </button>
          </>
        )
      }
    >
      {!saved && (
        <div className="form">
          <div className="field">
            <span className="label" id="f-customer">
              Customer
            </span>
            <Combobox
              labelledBy="f-customer"
              searchLabel="Search customers"
              value={customerId}
              onChange={setCustomerId}
              options={customers.map((c) => ({ value: String(c.id), label: c.name, hint: c.state }))}
            />
          </div>
          <div className="form-row">
            <div className="field">
              <span className="label" id="f-model">
                Tractor model
              </span>
              <Select
                labelledBy="f-model"
                value={model}
                onChange={setModel}
                options={TRACTOR_MODELS.map((m) => ({ value: m.code, label: m.code, hint: `${m.name}, ${m.horsepower} hp` }))}
              />
            </div>
            <label className="field" style={{ maxWidth: 120 }}>
              <span className="label">Quantity</span>
              <input type="number" min={1} max={50} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
            </label>
          </div>
          <div className="form-row">
            <div className="field">
              <span className="label" id="f-wh">
                Deliver from
              </span>
              <Select
                labelledBy="f-wh"
                value={warehouse}
                onChange={setWarehouse}
                options={[
                  { value: OWN_STATE, label: "Customer's state", hint: customer?.state },
                  ...WAREHOUSES.map((w) => ({ value: w.code, label: w.name, hint: w.code })),
                ]}
              />
            </div>
            <div className="field">
              <span className="label" id="f-date">
                Requested delivery
              </span>
              <DatePicker labelledBy="f-date" value={requested} onChange={setRequested} after={props.asOf} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
