import React from "react";
import { createRoot } from "react-dom/client";

import "../../web/src/styles.css";
import "../../web/src/workspace-polish.css";
import "./desktop.css";
import { DesktopApp } from "./DesktopApp";

const root = document.getElementById("app");
if (root) createRoot(root).render(<DesktopApp />);
