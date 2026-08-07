mod endpoint;
mod error;
mod gateway;
mod image;
mod protocol;
mod registry;
mod types;

pub(crate) use error::CommandError;
pub(crate) use gateway::{
    cancel_native_generation, check_native_model_connection, embed_native_model,
    list_native_models, rerank_native_model, start_native_generation, ModelGatewayState,
};
pub(crate) use image::{
    choose_native_image_destination, generate_native_image_to_file, NativeImageDestinationState,
};
