import catalog from './plants.json' with { type: 'json' };

const images = new Map(Object.entries(catalog.images));

export function withCatalogImage(plant) {
  const image = images.get(plant.id);
  return image ? { ...plant, image } : plant;
}

export const catalogImagePaths = new Set(images.values());
