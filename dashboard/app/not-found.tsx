export default function NotFound() {
  return (
    <main id="content" tabIndex={-1} className="notice">
      <h1>Contact not found</h1>
      <p>That link does not match a contact in the database.</p>
      <p><a href="/">Back to conversations</a></p>
    </main>
  );
}
