import { Outlet } from 'react-router';

export function AppLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-[1280px] px-4 py-6 lg:px-6">
        <Outlet />
      </main>
    </div>
  );
}
