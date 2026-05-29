use serde::{ser::SerializeStruct, Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("no project open")]
    NoProject,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("db error: {0}")]
    Db(String),
    #[error("pty error: {0}")]
    Pty(String),
    #[error("git error: {0}")]
    Git(String),
    #[error("agent error: {0}")]
    Agent(String),
    #[error("lsp error: {0}")]
    Lsp(String),
}

impl CommandError {
    fn kind(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::Io(_) => "io",
            Self::NoProject => "no_project",
            Self::Forbidden(_) => "forbidden",
            Self::Db(_) => "db",
            Self::Pty(_) => "pty",
            Self::Git(_) => "git",
            Self::Agent(_) => "agent",
            Self::Lsp(_) => "lsp",
        }
    }
}

// Serialize every variant — including unit variants — with a `message` from `Display`,
// so the frontend's `message: string` contract always holds.
impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("CommandError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<sqlx::Error> for CommandError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e.to_string())
    }
}

impl From<git2::Error> for CommandError {
    fn from(e: git2::Error) -> Self {
        Self::Git(e.message().to_owned())
    }
}
