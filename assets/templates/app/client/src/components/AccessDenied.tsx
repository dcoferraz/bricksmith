export function AccessDenied({ email }: { email?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">Access required</h1>
        <p className="text-sm text-slate-600">
          {email ? `${email} is` : 'You are'} not a member of a group that may use this app. Ask the app owner to add you to
          the read or write group.
        </p>
      </div>
    </div>
  );
}
