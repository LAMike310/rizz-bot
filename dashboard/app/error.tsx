'use client';

export default function Error({reset}: {error: Error; reset: () => void}) {
  return (
    <main id="content" tabIndex={-1} className="notice">
      <h1>Temporarily unavailable</h1>
      <p>The inbox could not refresh. The database was not modified.</p>
      <button type="button" onClick={() => reset()}>Try again</button>
    </main>
  );
}
