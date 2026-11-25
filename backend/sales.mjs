import { transaction } from './db.mjs';
import { reviseBatch } from './inventory.mjs';
import { ApiError, invalid, object, quantity, string } from './validation.mjs';

function readReceipt(input) {
  object(input, 'чек');
  const registerId = string(input.register_id, 'register_id', 128);
  const receiptId = string(input.receipt_id, 'receipt_id', 128);
  if (input.status !== 'paid') throw new ApiError(422, 'receipt_not_paid', 'Ожидался оплаченный чек (paid).');
  if (!Array.isArray(input.items) || !input.items.length) invalid('Чек должен содержать позиции растений.');
  const totals = new Map();
  for (const item of input.items) {
    object(item, 'items[]');
    const plantId = string(item.plant_id, 'plant_id');
    totals.set(plantId, quantity((totals.get(plantId) ?? 0) + quantity(item.quantity, 1), 1));
  }
  // A till can change line order or split one SKU into several lines on retry.
  const items = [...totals.keys()].sort().map(plant_id => ({ plant_id, quantity: totals.get(plant_id) }));
  return { registerId, receiptId, items };
}

function receiptResult(db, receipt, replayed) {
  const movements = db.prepare(`
    SELECT b.plant_id, e.batch_id, e.location_after AS location,
           e.quantity_before - e.quantity_after AS sold, e.quantity_after AS remaining_after_sale
    FROM batch_events e JOIN plant_batches b ON b.id = e.batch_id
    WHERE e.sale_id = ? ORDER BY e.id`).all(receipt.id);
  return { register_id: receipt.register_id, receipt_id: receipt.receipt_id,
    applied_at: receipt.applied_at, replayed, movements };
}

export function recordSale(db, input) {
  const { registerId, receiptId, items } = readReceipt(input);
  const contents = JSON.stringify(items);
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM paid_receipts WHERE register_id = ? AND receipt_id = ?')
      .get(registerId, receiptId);
    if (existing) {
      if (existing.items_json !== contents) {
        throw new ApiError(409, 'receipt_conflict', 'Под этим номером уже проведён чек с другими позициями.');
      }
      return receiptResult(db, existing, true);
    }

    const at = new Date().toISOString();
    const receipt = db.prepare(`
      INSERT INTO paid_receipts(register_id, receipt_id, items_json, applied_at)
      VALUES (?, ?, ?, ?) RETURNING *`).get(registerId, receiptId, contents, at);
    const known = db.prepare('SELECT 1 FROM plants WHERE id = ?');
    const ready = db.prepare(`
      SELECT * FROM inventory WHERE plant_id = ? AND stage = 'ready' AND quantity > 0 ORDER BY id`);
    for (const item of items) {
      if (!known.get(item.plant_id)) {
        throw new ApiError(422, 'unknown_plant', 'Неизвестный артикул растения.', { plant_id: item.plant_id });
      }
      const batches = ready.all(item.plant_id);
      const available = batches.reduce((sum, batch) => sum + batch.quantity, 0);
      if (available < item.quantity) {
        throw new ApiError(409, 'insufficient_stock', 'Недостаточно растений, готовых к продаже.',
          { plant_id: item.plant_id, requested: item.quantity, available });
      }
      let remaining = item.quantity;
      for (const batch of batches) {
        const take = Math.min(remaining, batch.quantity);
        reviseBatch(db, batch, { quantity: batch.quantity - take }, { kind: 'sale', at, saleId: receipt.id });
        remaining -= take;
        if (remaining === 0) break;
      }
    }
    return receiptResult(db, receipt, false);
  });
}
