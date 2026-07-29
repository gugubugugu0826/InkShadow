mod endpoint;
mod error;
mod gateway;
mod protocol;
mod registry;
mod types;

pub(crate) use error::CommandError;
pub(crate) use gateway::{
    cancel_native_generation, check_native_model_connection, embed_native_model,
    list_native_models, start_native_generation, ModelGatewayState,
};
