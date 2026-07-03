import { createBrowserRouter } from "react-router";
import { App } from "./App.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "projects/:projectId", element: <ProjectPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
