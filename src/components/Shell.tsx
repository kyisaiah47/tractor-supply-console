"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ListChecks, ChartLine, Truck, PlusCircle } from "@phosphor-icons/react";
import { Mark } from "./Mark";
import { ChatDock } from "./ChatDock";
import { NewOrderModal } from "./NewOrderModal";
import { day, stamp } from "@/lib/format";
import { useLocalFlag } from "@/lib/useNow";

const NAV = [
  { href: "/", label: "Orders", Icon: ListChecks },
  { href: "/models", label: "Models", Icon: ChartLine },
  { href: "/supply", label: "Supply orders", Icon: Truck },
];

export function Shell(props: { children: React.ReactNode; asOf: string; modelsRanAt: string | null }) {
  const path = usePathname();
  const [dockMin, setDockMin] = useLocalFlag("dock-min");
  const [newOrder, setNewOrder] = useState(false);

  return (
    <>
      <header className="masthead">
        <Link href="/" className="brand">
          <Mark />
          Tractor Supply Console
        </Link>
        <span className="standing">Demand, delays, failures, orders</span>
        <nav className="nav" aria-label="Main">
          {NAV.map(({ href, label, Icon }) => {
            const current = href === "/" ? path === "/" : path.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={current ? "page" : undefined}>
                <Icon size={16} weight="regular" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="spacer" />
        <div className="live" title="Everything in the console is shown as of this date">
          <i className="dot" />
          Planning date {day(props.asOf)}
        </div>
        <div className="live dim-live">Forecasts updated {stamp(props.modelsRanAt)}</div>
        <button className="btn primary" onClick={() => setNewOrder(true)}>
          <PlusCircle size={16} />
          New order
        </button>
      </header>
      <div className={`app ${dockMin ? "dock-min" : ""}`}>
        <main className="main">{props.children}</main>
        <ChatDock minimized={dockMin} onToggle={() => setDockMin(!dockMin)} />
      </div>
      <NewOrderModal open={newOrder} onOpenChange={setNewOrder} asOf={props.asOf} />
    </>
  );
}
