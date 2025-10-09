const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Firebase Admin
const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ✅ MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@coffeestore.vf4l8z4.mongodb.net/?retryWrites=true&w=majority&appName=coffeeStore`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("parcelDB");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    // ✅ custom middleware for Firebase auth
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access!" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // ✅ Upsert User
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.status(200).send({
          message: "user already exist",
          insertedId: false,
        });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // ✅ Search users & update admin role
    app.get("/users/search", async (req, res) => {
      try {
        const emailQuery = req.query.email;
        if (!emailQuery) {
          return res.status(400).send({ error: "Email query is required" });
        }

        const regex = new RegExp(emailQuery, "i"); // case-insensitive search
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, role: 1, createdAt: 1 }) // only needed fields
          .limit(10)
          .toArray();

        res.send(users);
      } catch (err) {
        console.error("Error searching users:", err);
        res.status(500).send({ error: "Failed to search users" });
      }
    });

    // ✅ Get all parcels OR filter by user email
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { created_by: userEmail } : {};
        const options = { sort: { createdAt: -1 } };

        const parcels = await parcelsCollection.find(query, options).toArray();

        res.status(200).send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // ✅ Add new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const parcel = req.body;
        parcel.createdAt = new Date();
        const result = await parcelsCollection.insertOne(parcel);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    // ✅ Get parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        res.send(parcel);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // ✅ Delete parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // ✅ Add new rider
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });
    // ✅ PATCH: Update rider status
    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;

      try {
        // 🔹 Update rider status
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );
        // update user role for accepting rider.
        if (status === "active") {
          const userQuery = { email };
          const userUpdatedDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await usersCollection.updateOne(
            userQuery,
            userUpdatedDoc
          );
          console.log(roleResult.modifiedCount);
        }
        res.send({
          message: `Rider status updated to ${status}`,
          riderModifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Error updating rider status:", error);
        res.status(500).send({ error: "Failed to update rider status" });
      }
    });

    // ✅ Pending riders API
    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to load pending riders:", error);
        res.status(500).send({ message: "Failed to load pending riders" });
      }
    });

    // ✅ Active Riders API (updated)
    app.get("/riders/active", async (req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: "active" })
          .toArray();
        res.send(activeRiders);
      } catch (error) {
        console.error("Failed to load active riders:", error);
        res.status(500).send({ message: "Failed to load active riders" });
      }
    });

    // ✅ Deactivate Rider API (updated)
    app.patch("/riders/deactivate/:id", async (req, res) => {
      try {
        const riderId = req.params.id;

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { status: "inactive" } }
        );

        if (result.modifiedCount > 0) {
          res.send({
            success: true,
            message: "Rider deactivated successfully",
          });
        } else {
          res.status(404).send({ success: false, message: "Rider not found" });
        }
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Server error", error });
      }
    });

    // ✅ Update rider status (approve or cancel)
    app.patch("/riders/status/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body; // "active" or "cancelled"

        if (!["active", "cancelled"].includes(status)) {
          return res.status(400).send({ message: "Invalid status value" });
        }

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to update rider status", error });
      }
    });

    // ✅ Get all payments (protected)
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        if (req.decoded.email !== userEmail) {
          res.status(403).send({ message: "forbidden access" });
        }

        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { createdAt: -1 } };

        const payments = await paymentsCollection
          .find(query, options)
          .toArray();
        res.send(payments);
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // ✅ Save payment + update parcel
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, transactionId, amount, email, paymentMethod } =
          req.body;

        if (!parcelId || !ObjectId.isValid(parcelId)) {
          return res.status(400).send({ error: "Invalid parcelId" });
        }
        if (!transactionId || typeof transactionId !== "string") {
          return res.status(400).send({ error: "Invalid transactionId" });
        }
        if (!amount || isNaN(amount)) {
          return res.status(400).send({ error: "Invalid amount" });
        }
        if (!email || typeof email !== "string") {
          return res.status(400).send({ error: "Invalid email" });
        }

        const filter = { _id: new ObjectId(parcelId) };
        const updateParcel = {
          $set: {
            payment_status: "paid",
            paymentDate: new Date(),
            transactionId,
          },
        };
        const updateResult = await parcelsCollection.updateOne(
          filter,
          updateParcel
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).send({ error: "Parcel not found" });
        }

        const paymentDoc = {
          parcelId,
          email,
          transactionId,
          amount,
          paymentMethod,
          status: "succeeded",
          paid_at_string: new Date().toISOString(),
          createdAt: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.send({
          message: "Payment recorded successfully",
          insertedId: paymentResult.insertedId,
        });
      } catch (err) {
        res
          .status(500)
          .send({ error: "Internal Server Error", details: err.message });
      }
    });

    // ✅ Stripe Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const amountInCents = req.body.amountInCents;
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // ✅ Ping MongoDB
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Successfully connected to MongoDB!");
  } finally {
    // keep connection open
  }
}
run().catch(console.dir);

// ✅ Test Route
app.get("/", (req, res) => {
  res.send("🚀 Parcel Server is Running");
});

// ✅ Server listen
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
