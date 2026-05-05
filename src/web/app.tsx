import { Route, Switch } from "wouter";
import { Sidebar } from "./components/shell/sidebar";
import { LoginScreen } from "./screens/login";
import { QueueScreen } from "./screens/queue";
import { BucketsScreen } from "./screens/buckets";
import { AnalyzerScreen } from "./screens/analyzer";
import { ConsoleScreen } from "./screens/console";
import { SourcesScreen } from "./screens/sources";
import { SetupScreen } from "./screens/setup";
import { trpc } from "./trpc";

function parseRouteId(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function App() {
  const me = trpc.me.useQuery(undefined, { retry: false });

  if (me.isLoading) {
    return (
      <div className="min-h-screen w-screen flex items-center justify-center bg-bg-0 text-ink-3 mono text-xs">
        loading…
      </div>
    );
  }

  if (!me.data?.authenticated) {
    return <LoginScreen onAuthed={() => me.refetch()} />;
  }

  return (
    <div className="flex h-screen w-screen bg-bg-0 text-ink-1">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Switch>
          <Route path="/" component={QueueScreen} />
          <Route path="/queue" component={QueueScreen} />
          <Route path="/buckets" component={() => <BucketsScreen />} />
          <Route
            path="/buckets/:id"
            component={(props) => (
              <BucketsScreen selectedId={parseRouteId((props.params as { id: string }).id)} />
            )}
          />
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
