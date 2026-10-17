-- Seed: 12 hand-written flash-deal products (ids 1..12) + ~100k generated catalog items.
-- All brands are fictional. Prices are in paise (1/100 INR) — columns say "cents" for generality.

INSERT INTO catalog.products (id, sku, name, brand, category, description, price_cents, mrp_cents, deal_price_cents, is_deal, rating, review_count, image_seed) VALUES
 (1,  'HOT-0001', 'Nimbus X15 Pro 256GB',         'Nimbus',  'Mobiles',    'Flagship phone with a 6.7" 120Hz display, triple 48MP camera and all-day battery. The deal everyone set an alarm for.', 12990000, 13990000, 7999900, TRUE, 4.7, 48211, 11),
 (2,  'HOT-0002', 'Zephyr S Ultra 512GB',         'Zephyr',  'Mobiles',    'Titanium frame, 200MP camera, built-in stylus. Lowest price of the year during the sale.',                             12499900, 12999900, 7499900, TRUE, 4.6, 30512, 12),
 (3,  'HOT-0003', 'Orion Book Air 13 M-series',   'Orion',   'Laptops',    'Fanless ultralight laptop, 18-hour battery, 16GB unified memory.',                                                      9990000, 11490000, 6999000, TRUE, 4.8, 21004, 13),
 (4,  'HOT-0004', 'Pixelon 55" 4K OLED TV',       'Pixelon', 'TVs',        'Self-lit OLED pixels, Dolby Vision, 120Hz gaming mode. Limited units at this price.',                                  11999000, 15999000, 5499000, TRUE, 4.5, 9876, 14),
 (5,  'HOT-0005', 'Kestrel PlayBox 5 Slim',       'Kestrel', 'Gaming',     'Next-gen console with 1TB SSD and a wireless controller.',                                                             4999000, 5499000, 3499000, TRUE, 4.9, 61234, 15),
 (6,  'HOT-0006', 'Aurora Buds Pro 3',            'Aurora',  'Audio',      'Adaptive noise cancellation, spatial audio, 30-hour case battery.',                                                    1990000, 2490000, 799900, TRUE, 4.4, 120332, 16),
 (7,  'HOT-0007', 'Tempo Watch Series 9 GPS',     'Tempo',   'Wearables',  'Always-on retina display, ECG, crash detection and sleep tracking.',                                                   4190000, 4590000, 2499900, TRUE, 4.6, 40551, 17),
 (8,  'HOT-0008', 'Vortex Digital Air Fryer 6L',  'Vortex',  'Kitchen',    'Rapid air circulation, 8 presets, dishwasher-safe basket.',                                                             899900, 1299500, 349900, TRUE, 4.3, 88120, 18),
 (9,  'HOT-0009', 'Stride Runner Max Shoes',      'Stride',  'Footwear',   'Responsive foam running shoes with carbon plate.',                                                                     999900, 1499900, 399900, TRUE, 4.2, 15020, 19),
 (10, 'HOT-0010', 'Lumen Robot Vacuum X1',        'Lumen',   'Home',       'LiDAR navigation robot vacuum and mop with self-empty dock.',                                                         3499900, 4999900, 1599900, TRUE, 4.1, 7733, 20),
 (11, 'HOT-0011', 'Nova Z50 Mirrorless Kit',      'Nova',    'Cameras',    '24MP APS-C mirrorless camera with 16-50mm kit lens.',                                                                 7999900, 8999900, 4999900, TRUE, 4.7, 5120, 21),
 (12, 'HOT-0012', 'The ₹1 Mystery Box',           'BreakCart','Toys',      'Midnight-only flash deal: a mystery gadget box for ₹1. Twenty units. Good luck.',                                       199900, 499900, 100, TRUE, 3.9, 99999, 22);

SELECT setseed(0.42);

INSERT INTO catalog.products (id, sku, name, brand, category, description, price_cents, mrp_cents, rating, review_count, image_seed)
SELECT
  g,
  'SKU-' || lpad(g::text, 6, '0'),
  brand || ' ' || adj || ' ' || noun || ' ' || (100 + (g * 7919) % 900)::text,
  brand,
  category,
  'The ' || brand || ' ' || adj || ' ' || noun || ' is built for everyday ' || lower(category) || ' needs. '
    || (ARRAY['Engineered with premium materials and a two-year warranty.',
              'Loved by customers for its value, reliability and thoughtful design.',
              'Comes with free delivery, easy returns and no-cost EMI options.',
              'Rated highly for performance, battery life and build quality.',
              'A best seller in its class with thousands of verified reviews.'])[1 + g % 5]
    || ' ' || (ARRAY['Available in multiple colours.', 'Eco-friendly packaging.', 'Certified refurbished options available.',
                     'Ships in 24 hours.', 'Exclusive online launch edition.', 'Includes accessories bundle.'])[1 + (g / 5) % 6]
    || ' Model ' || (1000 + g % 9000)::text || '.',
  price,
  (price * (1.10 + random() * 0.5))::int,
  round((3.0 + random() * 2.0)::numeric, 1),
  (random() * random() * 40000)::int,
  g % 97
FROM (
  SELECT
    g,
    c.category,
    (ARRAY['Acme','Bolt','Cobalt','Delta','Ember','Fable','Granite','Halo','Iris','Juniper',
           'Kite','Lynx','Maple','Nimbus','Onyx','Pulse','Quartz','Raven','Sable','Tidal',
           'Umber','Vega','Willow','Xenon','Yarrow','Zinc','Aster','Briar','Cedar','Drift'])[1 + (g * 31) % 30] AS brand,
    (ARRAY['Pro','Lite','Max','Ultra','Classic','Smart','Eco','Prime','Neo','Air',
           'Plus','Mini','Edge','Flex','Core','Turbo','Zen','Nova','Swift','Prime X'])[1 + (g * 17) % 20] AS adj,
    (ARRAY[
      ARRAY['Phone','Smartphone','Handset','Phone Case','Charger'],
      ARRAY['Laptop','Notebook','Ultrabook','Chromebook','Laptop Stand'],
      ARRAY['LED TV','Smart TV','Projector','Soundbar','TV Mount'],
      ARRAY['Headphones','Earbuds','Speaker','Neckband','Microphone'],
      ARRAY['Smartwatch','Fitness Band','Smart Ring','Watch Strap','Tracker'],
      ARRAY['T-Shirt','Jacket','Jeans','Kurta','Hoodie'],
      ARRAY['Sneakers','Sandals','Boots','Loafers','Slippers'],
      ARRAY['Lamp','Curtains','Bedsheet','Wall Clock','Cushion'],
      ARRAY['Mixer Grinder','Cookware Set','Kettle','Toaster','Water Bottle'],
      ARRAY['Face Wash','Moisturiser','Perfume','Trimmer','Hair Dryer'],
      ARRAY['Novel','Cookbook','Notebook Set','Comic','Planner'],
      ARRAY['Building Blocks','RC Car','Puzzle','Board Game','Plush Toy'],
      ARRAY['Yoga Mat','Dumbbells','Cricket Bat','Football','Cycle'],
      ARRAY['Coffee Beans','Green Tea','Dry Fruits','Olive Oil','Basmati Rice'],
      ARRAY['Gamepad','Gaming Mouse','Mechanical Keyboard','Gaming Chair','Headset']
    ])[1 + g % 15][1 + (g / 15) % 5] AS noun,
    ((c.lo + floor(random() * (c.hi - c.lo)))::int) * 100 AS price
  FROM generate_series(13, 100000) g
  CROSS JOIN LATERAL (
    SELECT * FROM (VALUES
      (0, 'Mobiles', 6999, 89999), (1, 'Laptops', 24999, 149999), (2, 'TVs', 9999, 199999),
      (3, 'Audio', 499, 29999), (4, 'Wearables', 999, 49999), (5, 'Fashion', 299, 4999),
      (6, 'Footwear', 399, 9999), (7, 'Home', 199, 9999), (8, 'Kitchen', 299, 14999),
      (9, 'Beauty', 149, 4999), (10, 'Books', 99, 1499), (11, 'Toys', 199, 7999),
      (12, 'Sports', 299, 24999), (13, 'Grocery', 49, 2999), (14, 'Gaming', 999, 59999)
    ) AS t(idx, category, lo, hi)
    WHERE t.idx = g % 15
  ) c
) src;

-- Stock: tiny allocations for the hot deals, plenty for everything else.
INSERT INTO inventory.stock (sku, product_id, total, available)
SELECT sku, id, t, t FROM (
  SELECT sku, id,
    CASE id
      WHEN 1 THEN 100  WHEN 2 THEN 250  WHEN 3 THEN 150  WHEN 4 THEN 60
      WHEN 5 THEN 300  WHEN 6 THEN 2000 WHEN 7 THEN 800  WHEN 8 THEN 3000
      WHEN 9 THEN 2500 WHEN 10 THEN 400 WHEN 11 THEN 120 WHEN 12 THEN 20
      ELSE 500 + (random() * 4500)::int
    END AS t
  FROM catalog.products
) s;

INSERT INTO catalog.price_history (product_id, price_version, price_cents, deal_price_cents, valid_from)
SELECT id, 1, price_cents, deal_price_cents, '2000-01-01T00:00:00Z' FROM catalog.products;

INSERT INTO orders.coupons (code, max_uses, discount_cents, min_subtotal_cents) VALUES
  ('BIGSALE500', 200, 50000, 100000),
  ('WELCOME100', 1000000, 10000, 50000);

-- Pristine stock allocation used by the control plane's "reset-data" action
-- (prices are restored from price_history version 1).
CREATE TABLE inventory.stock_seed AS SELECT sku, total FROM inventory.stock;

ANALYZE;
