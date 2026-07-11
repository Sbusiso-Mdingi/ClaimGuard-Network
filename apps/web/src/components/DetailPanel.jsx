import React from "react";

export default function DetailPanel({ title, children, meta }) {
  return (
    <section className="panel">
      <header className="section-header">
        <h2>{title}</h2>
        {meta && <span className="pill">{meta}</span>}
      </header>
      <div>{children}</div>
    </section>
  );
}
