import { Route, Switch } from "wouter";
import { Sidebar } from "./components/shell/sidebar";
import { QueueScreen } from "./screens/queue";
import { BucketsScreen } from "./screens/buckets";
import { AnalyzerScreen } from "./screens/analyzer";
import { ConsoleScreen } from "./screens/console";
import { SourcesScreen } from "./screens/sources";
import { SetupScreen } from "./screens/setup";

export function App() {
  return (
    <div className="flex h-screen w-screen bg-bg-0 text-ink-1">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Switch>
          <Route path="/" component={QueueScreen} />
          <Route path="/queue" component={QueueScreen} />
          <Route path="/buckets" component={BucketsScreen} />
          <Route path="/analyzer" component={AnalyzerScreen} />
          <Route path="/console" component={ConsoleScreen} />
          <Route path="/sources" component={SourcesScreen} />
          <Route path="/setup" component={SetupScreen} />
          <Route>
            <div className="p-8 text-ink-3">Not found.</div>
          </Route>
        </Switch>
      </main>
    </div>
  );
}
